import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

export type JobStatus = 'new' | 'done';

// Черга задач post-processing (hw-14): чекаут (checkout.ts) кладе сюди рядок
// в ОДНІЙ транзакції з оформленням замовлення (лист/чек виконується окремо —
// саме тому це задача в черзі, а не синхронний виклик усередині checkout).
// Воркер-пул (queue-worker.ts) розбирає її запитом
// FOR UPDATE SKIP LOCKED — тому тримає лише ті колонки, які цьому потрібні
// (status/worker/processed), без relations на боці Order.
@Entity('job_queue')
@Check(`"status" IN ('new', 'done')`)
export class JobQueue {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  // CASCADE: задача post-processing без свого замовлення сенсу не має —
  // та сама логіка, що order_items.order.
  @ManyToOne(() => Order, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'text', default: 'post_processing' })
  kind: string;

  @Column({ type: 'text', default: 'new' })
  status: JobStatus;

  // Хто з воркерів забрав задачу — заповнюється по COMMIT, а не по SELECT
  // (лок тримається до кінця обробки, статус і worker комітяться разом).
  @Column({ type: 'text', nullable: true })
  worker: string | null;

  // Лічильник фактичних обробок: інваріант SKIP LOCKED — рівно 1 на задачу.
  // >1 означало б, що двоє воркерів обробили той самий рядок.
  @Column({ type: 'int', default: 0 })
  processed: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;
}
