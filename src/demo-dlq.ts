// hw-19, demo:dlq — отруєне повідомлення (не JSON) іде окремим контуром:
// reject(requeue=false) -> shop.dlx -> shop.order-placed.dlq; причина
// читається з x-first-death-reason / x-death.
import 'reflect-metadata';
import * as amqp from 'amqplib';
import { brokerUrl } from './messaging/config';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, queueDepths, resetState, sleep, waitFor } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { DLQ, ROUTING_KEY_ORDER_PLACED, WORK_QUEUE } from './messaging/topology';

const REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

async function main(): Promise<void> {
  const ds = await resetState();
  const consumer = await startConsumer({ dataSource: ds });
  const publisher = await EventPublisher.connect();

  await publisher.publishRaw(ROUTING_KEY_ORDER_PLACED, Buffer.from('{це не JSON, а отрута'), {
    messageId: 'poison-1',
    type: 'order.placed',
  });

  await waitFor('повідомлення в DLQ', async () => (await queueDepths([DLQ]))[0] === 1);
  await sleep(200);

  // Читаємо причину з заголовків (get + reject(requeue=true): повідомлення лишається в DLQ)
  const conn = await amqp.connect(brokerUrl());
  const ch = await conn.createChannel();
  const m = await ch.get(DLQ, { noAck: false });
  let reason = '';
  if (m) {
    const h = m.properties.headers ?? {};
    reason = String(h['x-first-death-reason'] ?? '');
    const deaths = (h['x-death'] ?? []) as Array<{ queue: string; reason: string; count: number }>;
    console.log(
      `x-death: ${deaths.map((d) => `queue=${d.queue} reason=${d.reason} count=${d.count}`).join('; ')}`,
    );
    ch.reject(m, true);
  }
  await ch.close();
  await conn.close();
  await sleep(200);

  const [work, dlq] = await queueDepths([WORK_QUEUE, DLQ]);
  const effect = await countEffects(ds);

  kv('rejected', consumer.stats.rejected);
  kv('work', work);
  kv('dlq', dlq);
  kv('dlq-reason', reason);
  kv('effect', effect);

  await publisher.close();
  await consumer.close();
  await ds.destroy();

  const bad: string[] = [];
  if (work !== 0) bad.push(`work=${work}, очікувалось 0`);
  if (dlq !== 1) bad.push(`dlq=${dlq}, очікувалось 1`);
  if (!REASONS.includes(reason)) bad.push(`dlq-reason="${reason}" не з чотирьох дозволених`);
  if (effect !== 0) bad.push(`effect=${effect}: отрута не мала дати ефект`);
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
