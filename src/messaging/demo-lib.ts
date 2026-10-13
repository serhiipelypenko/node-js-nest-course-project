// Спільне для demo:publish / demo:dlq / demo:duplicate: контракт виводу
// (рядки ключ=значення), чистий старт, перевірка інваріанту з exit-кодом.
import * as amqp from 'amqplib';
import { DataSource } from 'typeorm';
import { brokerUrl } from './config';
import { assertTopology, depth, purgeAll } from './topology';
import { createDataSource } from '../concurrency/lib';

export const kv = (key: string, value: number | string): void => console.log(`${key}=${value}`);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
  what: string,
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дочекались: ${what} (${timeoutMs} мс)`);
    await sleep(50);
  }
}

/** Чистий стан: накотити міграції, оголосити топологію, спорожнити черги й таблицю ефектів. */
export async function resetState(): Promise<DataSource> {
  const ds = createDataSource(10);
  await ds.initialize();
  await ds.runMigrations(); // ідемпотентно: потрібна order_receipts на свіжому клоні
  // hw-22: inbox і outbox — частина стану ефекту; без них стара позначка
  // «оброблено» з минулого прогону мовчки з'їла б нову подію з тим самим eventId.
  await ds.query(`TRUNCATE outbox, processed_messages, idempotency_keys`);
  await ds.query(`DELETE FROM order_receipts`);

  const conn = await amqp.connect(brokerUrl());
  const ch = await conn.createChannel();
  await assertTopology(ch);
  await purgeAll(ch);
  await ch.close();
  await conn.close();
  return ds;
}

export async function queueDepths(queues: string[]): Promise<number[]> {
  const conn = await amqp.connect(brokerUrl());
  try {
    const out: number[] = [];
    for (const q of queues) {
      // checkQueue при помилці закриває канал — тому окремий канал на кожну чергу
      const ch = await conn.createChannel();
      out.push(await depth(ch, q));
      await ch.close();
    }
    return out;
  } finally {
    await conn.close();
  }
}

export async function countEffects(ds: DataSource): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(`SELECT count(*) AS n FROM order_receipts`);
  return Number(rows[0].n);
}

/** Інваріант порушено -> повідомлення в stderr і exit 1. */
export function assertInvariant(violations: string[]): void {
  if (violations.length > 0) {
    for (const v of violations) console.error(`ПОРУШЕНО ІНВАРІАНТ: ${v}`);
    process.exit(1);
  }
}
