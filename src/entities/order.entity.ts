import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { numericTransformer } from './numeric.transformer';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'cancelled'
  | 'refunded';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'paid',
  'shipped',
  'cancelled',
  'refunded',
];

// Головна таблиця домену. customerEmail — знімок пошти покупця на момент
// замовлення (як у db/schema.sql: користувач міг згодом змінити email, а
// замовлення лишається з тим, на який його оформили).
@Entity('orders')
@Check(`"status" IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded')`)
@Check('"total_amount" >= 0')
export class Order {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  // Історію (чиї це були замовлення) видаленням users не ламаємо —
  // RESTRICT: покупця з замовленнями видалити не можна.
  @ManyToOne(() => User, (user) => user.orders, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'buyer_id' })
  buyer: User;

  @Column({ type: 'text', name: 'customer_email' })
  customerEmail: string;

  @Column({ type: 'text' })
  status: OrderStatus;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    name: 'total_amount',
    transformer: numericTransformer,
  })
  totalAmount: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  // Позиції — діти замовлення: видалили order -> items ідуть слідом
  // (CASCADE стоїть на боці FK-колонки, order-item.entity.ts).
  @OneToMany(() => OrderItem, (item) => item.order)
  items: OrderItem[];
}
