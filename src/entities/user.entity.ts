import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';

// Покупці. Відповідає db/schema.sql (hw-12) 1:1: bigint IDENTITY (не serial —
// без окремого об'єкта-sequence зі своїми правами), email — природний ключ
// входу, тому NOT NULL UNIQUE.
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ type: 'text', name: 'full_name' })
  fullName: string;

  // Звичайний @Column, НЕ @CreateDateColumn: TypeORM примусово підставляв би
  // new Date() при кожному save(), а seed.ts свідомо ставить старі дати
  // заднім числом, щоб дані були детермінованими між прогонами.
  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  // onDelete тут немає навмисно: users не видаляють з коду цього ДЗ, а
  // дефолт FK (NO ACTION) уже захищає історію — покупця з замовленнями не
  // видалити. Явний RESTRICT стоїть на боці orders.buyer (там, де вирішує
  // FK-колонка), щоб не дублювати одну й ту саму політику на обох кінцях.
  @OneToMany(() => Order, (order) => order.buyer)
  orders: Order[];
}
