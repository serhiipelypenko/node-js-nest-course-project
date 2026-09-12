import { Check, Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { numericTransformer } from './numeric.transformer';
import { OrderItem } from './order-item.entity';

// Каталог товарів. price — numeric(12,2), не float (0.1 не зберігається
// точно, суми "пливуть") — те саме рішення, що в db/schema.sql hw-12.
@Entity('products')
@Check('"price" >= 0')
export class Product {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  @Column({ type: 'text', unique: true })
  sku: string;

  @Column({ type: 'text' })
  name: string;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  price: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  // Товар, на який уже є продажі, просто так не видалити — RESTRICT
  // стоїть на боці FK-колонки (order-item.entity.ts), тут лише зворотний бік.
  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: OrderItem[];
}
