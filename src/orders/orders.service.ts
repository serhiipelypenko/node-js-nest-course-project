import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { Page, paginate } from '../common/cursor';
import { ProductsService } from '../products/products.service';
import { OrderEventsService } from './order-events.service';

export interface OrderItem {
  product_id: string;
  quantity: number;
}

// Незалежний від `OrderStatus` у src/entities/order.entity.ts (hw-13/14) —
// той описує СПРАВЖНЮ таблицю orders у Postgres data-шару, цей — in-memory
// каталог HTTP-шару. Лінійний перебіг
// new -> packed -> shipped -> delivered, cancelled — у будь-який момент.
export type OrderStatus = 'new' | 'packed' | 'shipped' | 'delivered' | 'cancelled';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
];

export interface Order {
  id: string;
  // Хто власник замовлення — потрібен gateway (orders.gateway.ts), щоб
  // відмовляти анонімному/чужому клієнту в join у кімнату orders:<id>.
  // За замовчуванням 'guest' — щоб POST /orders без buyer_id (як у hw-16
  // e2e/contract тестах) і далі повертав 201, а не 400.
  buyer_id: string;
  items: OrderItem[];
  total_cents: number;
  status: OrderStatus;
  created_at: string;
}

const ORDERS: Order[] = [
  {
    id: 'o1',
    buyer_id: 'u1',
    items: [{ product_id: 'p1', quantity: 1 }],
    total_cents: 129900,
    status: 'new',
    created_at: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'o2',
    buyer_id: 'u2',
    items: [
      { product_id: 'p2', quantity: 2 },
      { product_id: 'p3', quantity: 1 },
    ],
    total_cents: 45900 * 2 + 12900,
    status: 'new',
    created_at: '2026-08-02T11:30:00.000Z',
  },
];
let nextId = 3;

@Injectable()
export class OrdersService {
  constructor(
    private readonly products: ProductsService,
    private readonly orderEvents: OrderEventsService,
  ) {}

  list(limit: number, cursor?: string): Page<Order> {
    return paginate(ORDERS, limit, cursor);
  }

  // Рівень ВЛАСНОСТІ (hw-24). Перевіряється тут, ПІСЛЯ завантаження ресурсу, а
  // не в гарді: гард стоїть до handler-а й не знає buyer_id замовлення — щоб
  // його дізнатись, довелося б ходити по ресурс двічі. Зі справжньою БД це був
  // би один запит `… WHERE id = $1 AND buyer_id = $2` (без рядка — 404/403 без
  // другого round-trip). admin бачить усе.
  getOwned(id: string, user: AuthUser): Order {
    const order = this.getById(id);
    if (order.buyer_id !== user.id && user.role !== 'admin') {
      throw new ForbiddenException({
        code: 'not-owner',
        detail: 'це замовлення належить іншому користувачеві',
      });
    }
    return order;
  }

  // Список: той самий принцип — фільтр за власником ДО пагінації, а не після.
  listFor(user: AuthUser, limit: number, cursor?: string): Page<Order> {
    const visible = user.role === 'admin' ? ORDERS : ORDERS.filter((o) => o.buyer_id === user.id);
    return paginate(visible, limit, cursor);
  }

  getById(id: string): Order {
    const order = ORDERS.find((o) => o.id === id);
    if (!order) {
      throw new NotFoundException({ detail: `замовлення "${id}" не знайдено` });
    }
    return order;
  }

  create(items: OrderItem[], buyerId: string): Order {
    const totalCents = items.reduce((sum, item) => {
      const [product] = this.products.findByIds([item.product_id]);
      return sum + (product?.price_cents ?? 0) * item.quantity;
    }, 0);

    const order: Order = {
      id: `o${nextId++}`,
      buyer_id: buyerId,
      items,
      total_cents: totalCents,
      status: 'new',
      created_at: new Date().toISOString(),
    };
    ORDERS.push(order);
    return order;
  }

  // Бізнес-логіка зміни статусу — і єдине місце, звідки йде emit у realtime-шину.
  updateStatus(id: string, status: OrderStatus): Order {
    const order = this.getById(id);
    order.status = status;
    this.orderEvents.emitStatusChange(order.id, status);
    return order;
  }
}
