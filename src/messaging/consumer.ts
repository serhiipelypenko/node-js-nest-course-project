// hw-19: споживач order.placed.
//  - noAck: false, ack ПІСЛЯ ефекту (ack = «я більше не вимагаю повтору»);
//  - prefetch виставлено явно (PREFETCH у config.ts);
//  - ефект ідемпотентний у двох рівнях (hw-22): inbox processed_messages + природний
//    ключ order_id, обидва INSERT ... ON CONFLICT DO NOTHING в ОДНІЙ транзакції Postgres;
//  - отруєне повідомлення (не JSON / не за контрактом) -> reject(requeue=false) -> DLX.
import * as amqp from 'amqplib';
import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { brokerUrl, PREFETCH } from './config';
import { OrderPlacedEvent, OrderPlacedSchema } from './events';
import { assertTopology, WORK_QUEUE } from './topology';

export interface ConsumerStats {
  delivered: number;
  applied: number;
  skipped: number;
  acked: number;
  rejected: number;
}

export interface ConsumerHooks {
  onRecv?(m: { eventId?: string; redelivered: boolean }): void;
  onEffect?(eventId: string): void;
  onSkip?(eventId: string): void;
  onAcked?(eventId: string): void;
  /** Брокер скасував підписку (basic.cancel, наприклад consumer_timeout). */
  onCancel?(): void;
}

export interface ConsumerOptions {
  dataSource: DataSource;
  prefetch?: number;
  /** Лише для demo:duplicate: пауза між ефектом і ack, у яку стріляє SIGKILL. */
  gapMs?: number;
  hooks?: ConsumerHooks;
}

export interface RunningConsumer {
  stats: ConsumerStats;
  prefetch: number;
  close(): Promise<void>;
}

// Імʼя консюмера в inbox: складений ключ (message_id, consumer) — те саме
// повідомлення різні консюмери обробляють кожен окремо.
export const CONSUMER_NAME = 'order-receipts';

/**
 * true — ефект застосовано; false — дубль.
 *
 * Два рівні ідемпотентності в ОДНІЙ транзакції (позначка в processed_messages і
 * ефект — один COMMIT; позначка деінде, ніж ефект, — знову dual write):
 *   рівень 2 (inbox): INSERT processed_messages ON CONFLICT DO NOTHING — вже
 *     бачили message_id -> нічого не робимо;
 *   рівень 1 (природний ключ): ефект — «квитанція замовлення існує»
 *     (UNIQUE order_id), а не «збільшити лічильник»; повтор нічого не змінює навіть
 *     якщо inbox почистили за TTL.
 */
export async function applyOrderPlaced(ds: DataSource, e: OrderPlacedEvent): Promise<boolean> {
  return ds.transaction(async (m) => {
    // INSERT ... RETURNING у TypeORM повертає масив рядків (не tuple, як UPDATE)
    const seen: unknown = await m.query(
      `INSERT INTO processed_messages (message_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [e.eventId, CONSUMER_NAME],
    );
    if (!Array.isArray(seen) || seen.length === 0) return false; // дубль: ack і далі

    const rows: unknown = await m.query(
      `INSERT INTO order_receipts (event_id, order_id, buyer_id, total_amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [e.eventId, e.data.orderId, e.data.buyerId, e.data.totalAmount],
    );
    return Array.isArray(rows) && rows.length > 0;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startConsumer(opts: ConsumerOptions): Promise<RunningConsumer> {
  const { dataSource, hooks = {}, gapMs = 0 } = opts;
  const prefetch = opts.prefetch ?? PREFETCH;
  const stats: ConsumerStats = { delivered: 0, applied: 0, skipped: 0, acked: 0, rejected: 0 };

  const conn: ChannelModel = await amqp.connect(brokerUrl());
  const ch = await conn.createChannel();
  await assertTopology(ch);
  await ch.prefetch(prefetch);

  const handle = async (msg: ConsumeMessage): Promise<void> => {
    stats.delivered += 1;
    hooks.onRecv?.({ eventId: msg.properties.messageId, redelivered: msg.fields.redelivered });

    let event: OrderPlacedEvent;
    try {
      event = OrderPlacedSchema.parse(JSON.parse(msg.content.toString()));
    } catch {
      // Повтор нічого не змінить: payload не стане валідним. У DLQ, а не назад.
      stats.rejected += 1;
      ch.reject(msg, false);
      return;
    }

    try {
      const applied = await applyOrderPlaced(dataSource, event);
      if (applied) {
        stats.applied += 1;
        hooks.onEffect?.(event.eventId);
      } else {
        stats.skipped += 1;
        hooks.onSkip?.(event.eventId);
      }
      if (gapMs > 0) await sleep(gapMs);
      ch.ack(msg); // ПІСЛЯ ефекту
      stats.acked += 1;
      hooks.onAcked?.(event.eventId);
    } catch {
      // Тимчасова помилка (БД недоступна): повернути в чергу. reject(requeue=true)
      // інкрементує delivery-count, тож x-delivery-limit обмежує цикл.
      try {
        ch.reject(msg, true);
      } catch {
        /* канал уже закрито — брокер сам поверне повідомлення */
      }
    }
  };

  await ch.consume(
    WORK_QUEUE,
    (msg) => {
      if (msg === null) {
        // basic.cancel від брокера: інакше код «ще працює» і шле ack у нікуди
        hooks.onCancel?.();
        return;
      }
      void handle(msg);
    },
    { noAck: false },
  );

  return {
    stats,
    prefetch,
    async close() {
      await ch.close().catch(() => undefined);
      await conn.close().catch(() => undefined);
    },
  };
}
