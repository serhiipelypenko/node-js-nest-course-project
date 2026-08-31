import { Injectable, NotFoundException } from '@nestjs/common';
import { Page, paginate } from '../common/cursor';
import { ProductsService } from '../products/products.service';

export interface OrderItem {
  product_id: string;
  quantity: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  total_cents: number;
  status: 'new';
  created_at: string;
}

const ORDERS: Order[] = [
  {
    id: 'o1',
    items: [{ product_id: 'p1', quantity: 1 }],
    total_cents: 129900,
    status: 'new',
    created_at: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'o2',
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
  constructor(private readonly products: ProductsService) {}

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

  create(items: OrderItem[]): Order {
    const totalCents = items.reduce((sum, item) => {
      const [product] = this.products.findByIds([item.product_id]);
      return sum + (product?.price_cents ?? 0) * item.quantity;
    }, 0);

    const order: Order = {
      id: `o${nextId++}`,
      items,
      total_cents: totalCents,
      status: 'new',
      created_at: new Date().toISOString(),
    };
    ORDERS.push(order);
    return order;
  }
}
