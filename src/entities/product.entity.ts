import { Check, Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { numericTransformer } from './numeric.transformer';
import { OrderItem } from './order-item.entity';

// Каталог товарів. price — numeric(12,2), не float (0.1 не зберігається
// точно, суми "пливуть") — те саме рішення, що в db/schema.sql hw-12.
// stock (hw-14) — залишок на складі: чекаут hw-14 декрементує його
// атомарним UPDATE ... WHERE stock >= $n, тому CHECK stock >= 0 — це той
// самий інваріант, який охороняє й сам запит, а не проти нього.
@Entity('products')
@Check('"price" >= 0')
@Check('"stock" >= 0')
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

  // Склад товару (hw-14). Дефолт 0 — навмисно: каталог hw-12/13 наповнюється
  // без stock (демо N+1/звіт його не потребують), а власні товари демо
  // конкурентності hw-14 виставляють stock явно через upsert.
  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  // Товар, на який уже є продажі, просто так не видалити — RESTRICT
  // стоїть на боці FK-колонки (order-item.entity.ts), тут лише зворотний бік.
  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: OrderItem[];
}
