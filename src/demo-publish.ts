// hw-19, demo:publish — happy path: 5 реальних checkout() -> outbox (hw-22) -> relay
// публікує order.placed (confirm-канал), споживач з ручним ack і prefetch застосовує
// 5 ефектів. (До hw-22 checkout публікував сам після COMMIT — dual write.)
import 'reflect-metadata';
import { checkout } from './checkout';
import { PREFETCH } from './messaging/config';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, queueDepths, resetState, sleep, waitFor } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { relayUntilEmpty } from './outbox/relay';
import { DLQ, UNROUTABLE_QUEUE, WORK_QUEUE } from './messaging/topology';

const EVENTS = 5;

async function main(): Promise<void> {
  const ds = await resetState();

  const [product]: Array<{ id: string }> = await ds.query(
    `INSERT INTO products (sku, name, price, stock)
     VALUES ('MQ-DEMO', 'Товар демо RabbitMQ', 100, 1000)
     ON CONFLICT (sku) DO UPDATE SET stock = 1000, price = 100
     RETURNING id`,
  );
  const [buyer]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, full_name)
     VALUES ('mq-demo@example.com', 'Покупець демо RabbitMQ')
     ON CONFLICT (email) DO UPDATE SET balance = 1000000
     RETURNING id`,
  );

  const consumer = await startConsumer({ dataSource: ds, prefetch: PREFETCH });
  const publisher = await EventPublisher.connect();

  for (let i = 0; i < EVENTS; i++) {
    await checkout(ds, { buyerId: buyer.id, productId: product.id, quantity: 1 });
  }
  const published = await relayUntilEmpty(ds, publisher);

  // Контрольна публікація з routing key без binding: завдяки alternate exchange
  // вона не зникає мовчки, а лягає в shop.unroutable (у published не рахується).
  await publisher.publishRaw('order.unknown', Buffer.from('{}'));

  await waitFor('усі ефекти застосовані', async () => (await countEffects(ds)) >= EVENTS);
  await waitFor('усі ack відправлені', () => consumer.stats.acked >= EVENTS);
  await sleep(300); // зайвих доставок/ефектів не має зʼявитись

  const [work, dlq, unroutable] = await queueDepths([WORK_QUEUE, DLQ, UNROUTABLE_QUEUE]);
  const effect = await countEffects(ds);

  kv('published', published);
  kv('delivered', consumer.stats.delivered);
  kv('effect', effect);
  kv('acked', consumer.stats.acked);
  kv('work', work);
  kv('dlq', dlq);
  kv('unroutable', unroutable);
  kv('prefetch', consumer.prefetch);

  await publisher.close();
  await consumer.close();
  await ds.destroy();

  const bad: string[] = [];
  if (published !== EVENTS) bad.push(`published=${published}, очікувалось ${EVENTS}`);
  if (effect !== EVENTS) bad.push(`effect=${effect}, очікувалось ${EVENTS}`);
  if (consumer.stats.acked !== EVENTS) bad.push(`acked=${consumer.stats.acked}`);
  if (dlq !== 0) bad.push(`dlq=${dlq}, очікувалось 0`);
  if (work !== 0) bad.push(`work=${work}, очікувалось 0`);
  if (unroutable !== 1) bad.push(`unroutable=${unroutable}: alternate exchange не спрацював`);
  if (consumer.prefetch < 1 || consumer.prefetch > 2000) bad.push(`prefetch=${consumer.prefetch}`);
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
