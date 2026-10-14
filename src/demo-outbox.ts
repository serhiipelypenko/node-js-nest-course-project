// hw-22, demo:outbox — happy path через ВСІ шари:
//   2 HTTP-запити з тим самим Idempotency-Key -> 1 замовлення + 1 рядок outbox
//   (один COMMIT) -> relay (SKIP LOCKED) -> RabbitMQ -> консюмер (inbox + природний
//   ключ) -> 1 ефект.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, sleep, waitFor } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { countOrders, countOutbox, countProcessed, countPublished, prepareWorld } from './outbox/demo-lib';
import { createOrdersApi } from './outbox/orders-api';
import { startRelay } from './outbox/relay';

async function main(): Promise<void> {
  const { ds, buyerId, productId } = await prepareWorld('happy');

  const consumer = await startConsumer({ dataSource: ds });
  const publisher = await EventPublisher.connect();
  const server = createOrdersApi(ds);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Клієнт «не дочекався відповіді» й повторює той самий намір тим самим ключем.
  const key = `demo-outbox-${Date.now()}`;
  const post = () =>
    fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ buyer_id: buyerId, product_id: productId, quantity: 1 }),
    });
  const r1 = await post();
  const b1 = (await r1.json()) as { order_id: string };
  const r2 = await post();
  const b2 = (await r2.json()) as { order_id: string };
  const requests = 2;

  // relay стартує ПІСЛЯ запитів: подія спершу лежить у outbox (published=0),
  // і лише потім виноситься — окремим кроком, а не в транзакції замовлення.
  const unpublishedBefore = (await countOutbox(ds)) - (await countPublished(ds));
  const relay = startRelay(ds, publisher);
  await waitFor('подія винесена й оброблена', async () => (await countPublished(ds)) >= 1 && consumer.stats.acked >= 1);
  await sleep(300); // зайвих доставок/ефектів не має зʼявитись
  await relay.stop();

  const orders = await countOrders(ds, buyerId);
  const outbox = await countOutbox(ds);
  const published = await countPublished(ds);
  const effect = await countEffects(ds);
  const processed = await countProcessed(ds);
  const deliveries = consumer.stats.delivered;

  kv('requests', requests);
  kv('orders', orders);
  kv('outbox', outbox);
  kv('published', published);
  kv('deliveries', deliveries);
  kv('effect', effect);
  kv('processed', processed);
  kv('status1', r1.status);
  kv('status2', r2.status);
  kv('same_order', b1.order_id === b2.order_id ? 1 : 0);
  kv('unpublished_before_relay', unpublishedBefore);

  await publisher.close();
  await consumer.close();
  await new Promise((res) => server.close(res));
  await ds.destroy();

  const bad: string[] = [];
  if (r1.status !== 201) bad.push(`status1=${r1.status}, очікувалось 201`);
  if (r2.status !== 200 || r2.headers.get('idempotent-replayed') !== 'true') {
    bad.push(`status2=${r2.status}: повтор ключа має дати 200 + Idempotent-Replayed`);
  }
  if (b1.order_id !== b2.order_id) bad.push('повтор ключа дав інше замовлення');
  if (orders !== 1) bad.push(`orders=${orders}, очікувалось 1`);
  if (outbox !== 1) bad.push(`outbox=${outbox}, очікувалось 1`);
  if (unpublishedBefore !== 1) bad.push(`unpublished_before_relay=${unpublishedBefore}, очікувалось 1`);
  if (published !== 1) bad.push(`published=${published}, очікувалось 1`);
  if (effect !== 1) bad.push(`effect=${effect}, очікувалось 1`);
  if (processed !== 1) bad.push(`processed=${processed}, очікувалось 1`);
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
