import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.types';
import { checkout } from '../checkout';
import { decodeKeyCursor, keysetPage, Page } from '../common/cursor';
import { DATA_SOURCE, PG_POOL } from '../database/database.module';
import { isDbId } from '../products/products.service';
import { OrderEventsService } from './order-events.service';

export interface OrderItem {
  product_id: string;
  quantity: number;
}

// Статуси ПУБЛІЧНОГО контракту (openapi.yaml). Лінійний перебіг
// new -> packed -> shipped -> delivered, cancelled — у будь-який момент.
// У таблиці orders «new» зберігається як `paid` (checkout списує кошти одразу);
// маппінг в обидва боки — нижче, в одному місці.
export type OrderStatus = 'new' | 'packed' | 'shipped' | 'delivered' | 'cancelled';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
];

const API_TO_DB: Record<OrderStatus, string> = {
  new: 'paid',
  packed: 'packed',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

export interface Order {
  id: string;
  // Власник замовлення — sub токена. Потрібен gateway (orders.gateway.ts), щоб
  // відмовляти анонімному/чужому клієнту в join у кімнату orders:<id>.
  buyer_id: string;
  items: OrderItem[];
  total_cents: number;
  status: OrderStatus;
  created_at: string;
}

// Одне замовлення = один запит: позиції збираються json_agg-ом у тому ж SELECT
// (не N+1). Суми — в копійках цілим числом, статус — у термінах API.
const ORDER_SELECT = `
  SELECT o.id::text AS id,
         o.buyer_id::text AS buyer_id,
         CASE o.status WHEN 'paid' THEN 'new' WHEN 'pending' THEN 'new'
                       WHEN 'refunded' THEN 'cancelled' ELSE o.status END AS status,
         round(o.total_amount * 100)::int AS total_cents,
         o.created_at,
         COALESCE(
           json_agg(json_build_object('product_id', i.product_id::text, 'quantity', i.quantity)
                    ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json) AS items
  FROM orders o
  LEFT JOIN order_items i ON i.order_id = o.id`;

interface OrderRow extends Omit<Order, 'created_at'> {
  created_at: Date;
}

function toOrder(row: OrderRow): Order {
  return { ...row, created_at: row.created_at.toISOString() };
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly orderEvents: OrderEventsService,
  ) {}

  // Рівень ВЛАСНОСТІ (hw-24). Перевіряється тут, ПІСЛЯ завантаження ресурсу, а
  // не в гарді: гард стоїть до handler-а й не знає buyer_id замовлення.
  // admin бачить усе.
  async getOwned(id: string, user: AuthUser): Promise<Order> {
    const order = await this.getById(id);
    if (order.buyer_id !== user.id && user.role !== 'admin') {
      throw new ForbiddenException({
        code: 'not-owner',
        detail: 'це замовлення належить іншому користувачеві',
      });
    }
    return order;
  }

  // Список: фільтр за власником у самому SQL, ДО пагінації, а не після.
  async listFor(user: AuthUser, limit: number, cursor?: string): Promise<Page<Order>> {
    const after = cursor ? decodeKeyCursor(cursor) : '0';
    const own = user.role === 'admin' ? '' : 'AND o.buyer_id = $3';
    const params: unknown[] = [after, limit + 1];
    if (own) params.push(user.id);
    const { rows } = await this.pool.query<OrderRow>(
      `${ORDER_SELECT}
       WHERE o.id > $1 ${own}
       GROUP BY o.id
       ORDER BY o.id
       LIMIT $2`,
      params,
    );
    return keysetPage(rows.map(toOrder), limit);
  }

  async getById(id: string): Promise<Order> {
    const rows = isDbId(id)
      ? (await this.pool.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 GROUP BY o.id`, [id])).rows
      : [];
    if (rows.length === 0) {
      throw new NotFoundException({ detail: `замовлення "${id}" не знайдено` });
    }
    return toOrder(rows[0]!);
  }

  // Створення = checkout(): склад, баланс, замовлення, задача й подія в outbox
  // в ОДНІЙ транзакції. Idempotency-Key привʼязаний до покупця: два різні
  // користувачі з однаковим рядком ключа не повинні бачити чужі замовлення.
  async create(
    items: OrderItem[],
    buyerId: string,
    idempotencyKey: string,
  ): Promise<{ order: Order; replayed: boolean }> {
    if (!isDbId(buyerId)) {
      throw new ForbiddenException({ code: 'unknown-buyer', detail: 'покупця не знайдено' });
    }
    for (const item of items) {
      if (!isDbId(item.product_id)) {
        throw new NotFoundException({ code: 'product-not-found', detail: `товар "${item.product_id}" не знайдено` });
      }
    }
    const result = await checkout(this.dataSource, {
      buyerId,
      items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
      idempotencyKey: `${buyerId}:${idempotencyKey}`,
    });
    if (!result.ok) {
      if (result.reason === 'product_not_found') {
        throw new NotFoundException({ code: 'product-not-found', detail: 'один із товарів не знайдено' });
      }
      throw new ConflictException({
        code: result.reason === 'out_of_stock' ? 'out-of-stock' : 'insufficient-funds',
        detail: result.reason === 'out_of_stock' ? 'товару не вистачає на складі' : 'недостатньо коштів на балансі',
      });
    }
    return { order: await this.getById(result.orderId), replayed: result.replayed };
  }

  // Бізнес-логіка зміни статусу — і єдине місце, звідки йде emit у realtime-шину.
  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    if (!isDbId(id)) {
      throw new NotFoundException({ detail: `замовлення "${id}" не знайдено` });
    }
    const { rowCount } = await this.pool.query(`UPDATE orders SET status = $2 WHERE id = $1`, [
      id,
      API_TO_DB[status],
    ]);
    if (rowCount === 0) {
      throw new NotFoundException({ detail: `замовлення "${id}" не знайдено` });
    }
    this.orderEvents.emitStatusChange(id, status);
    return this.getById(id);
  }
}
