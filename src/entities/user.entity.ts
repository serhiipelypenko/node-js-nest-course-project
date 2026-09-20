import { Check, Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { numericTransformer } from './numeric.transformer';
import { Order } from './order.entity';

// Покупці. Відповідає db/schema.sql (hw-12) 1:1: bigint IDENTITY (не serial —
// без окремого об'єкта-sequence зі своїми правами), email — природний ключ
// входу, тому NOT NULL UNIQUE.
// balance (hw-14) — гроші покупця, numeric(12,2) як і всі суми в домені.
// Дефолт навмисно надлишковий (1000000.00): у демо конкурентності hw-14
// саме stock товару має бути дефіцитом, що обмежує число успішних чекаутів,
// а не випадковий брак коштів у покупця — інакше число успішних із гонки
// стане залежати від порядку виконання, а не лишиться рівно stock.
@Entity('users')
@Check('"balance" >= 0')
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

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 1000000,
    transformer: numericTransformer,
  })
  balance: number;

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
