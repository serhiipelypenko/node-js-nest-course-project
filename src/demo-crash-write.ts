// hw-22, demo:crash-write — перший бік «фейлу запису»: падає БІЗНЕС-запис.
//
// Транзакція checkout валиться вже ПІСЛЯ INSERT в outbox (hook afterOutboxInsert).
// Очікування: рядок outbox зникає РАЗОМ із замовленням (один COMMIT -> один
// ROLLBACK), relay нічого не знаходить, брокер нічого не отримує. Подія про
// неіснуюче замовлення неможлива — на відміну від hw-19, де publish ішов окремо.
import 'reflect-metadata';
import { checkout } from './checkout';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, queueDepths, sleep } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { WORK_QUEUE } from './messaging/topology';
import { countOrders, countOutbox, countPublished, prepareWorld, stockOf, DEMO_STOCK } from './outbox/demo-lib';
import { relayUntilEmpty } from './outbox/relay';

async function main(): Promise<void> {
  const { ds, buyerId, productId } = await prepareWorld('crash-write');
  const consumer = await startConsumer({ dataSource: ds });
  const publisher = await EventPublisher.connect();

  let outboxInserted = false;
  let writeFailed = 0;
  try {
    await checkout(
      ds,
      { buyerId, productId, quantity: 1, idempotencyKey: 'crash-write-1' },
      {
        afterOutboxInsert: () => {
          outboxInserted = true; // рядок outbox ВЖЕ вставлено в цій транзакції…
          throw new Error('збій бізнес-запису після INSERT в outbox'); // …і тут усе падає
        },
      },
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('збій бізнес-запису')) writeFailed = 1;
    else throw e;
  }

  // relay усе одно запускаємо: якби подія вціліла, він би її виніс
  await relayUntilEmpty(ds, publisher);
  await sleep(500); // дати брокеру/консюмеру шанс отримати те, чого бути не повинно

  const orders = await countOrders(ds, buyerId);
  const outbox = await countOutbox(ds);
  const published = await countPublished(ds);
  const deliveries = consumer.stats.delivered;
  const effect = await countEffects(ds);
  const [queued] = await queueDepths([WORK_QUEUE]);
  const stock = await stockOf(ds, productId);
  const [{ n: keys }]: Array<{ n: string }> = await ds.query(`SELECT count(*) AS n FROM idempotency_keys`);

  kv('write-failed', writeFailed);
  kv('orders', orders);
  kv('outbox', outbox);
  kv('published', published);
  kv('deliveries', deliveries);
  kv('effect', effect);
  kv('outbox_insert_reached', outboxInserted ? 1 : 0);
  kv('stock_restored', stock === DEMO_STOCK ? 1 : 0);
  kv('idempotency_keys', Number(keys));

  await publisher.close();
  await consumer.close();
  await ds.destroy();

  const bad: string[] = [];
  if (!outboxInserted) bad.push('збій не дійшов до точки після INSERT в outbox: демо нічого не доводить');
  if (writeFailed !== 1) bad.push(`write-failed=${writeFailed}, очікувалось 1`);
  if (orders !== 0) bad.push(`orders=${orders}, очікувалось 0`);
  if (outbox !== 0) bad.push(`outbox=${outbox}, очікувалось 0 (подія пережила замовлення!)`);
  if (published !== 0) bad.push(`published=${published}, очікувалось 0`);
  if (deliveries !== 0 || queued !== 0) bad.push(`deliveries=${deliveries}, queued=${queued}, очікувалось 0`);
  if (effect !== 0) bad.push(`effect=${effect}, очікувалось 0`);
  if (stock !== DEMO_STOCK) bad.push(`stock=${stock}: списання складу не відкотилось`);
  if (Number(keys) !== 0) bad.push('ключ ідемпотентності пережив відкат');
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
