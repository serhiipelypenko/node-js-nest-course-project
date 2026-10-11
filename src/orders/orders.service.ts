import { Injectable, NotFoundException } from '@nestjs/common';
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

  getById(id: string): Order {
    const order = ORDERS.find((o) => o.id === id);
    if (!order) {
      throw new NotFoundException({ detail: `замовлення "${id}" не знайдено` });
    }
    return order;
  }

  create(items: OrderItem[], buyerId = 'guest'): Order {
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
