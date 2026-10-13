// hw-22, demo:crash-relay ⭐ — другий бік «фейлу запису»: падає СЛУЖБОВИЙ запис.
//
// Relay (окремий процес) публікує подію, брокер підтверджує, і рівно перед
// UPDATE published_at процес отримує справжній kill -9. Транзакцію relay
// відкочує Postgres (обрив зʼєднання), рядок лишається published_at IS NULL.
// Рестартований relay публікує ту саму подію вдруге (той самий eventId).
// Консюмер (inbox + природний ключ) відкидає дубль: доставок ≥ 2, ефект один.
// Це і є «at-least-once доставка + ідемпотентний ефект = exactly-once результат».
import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { checkout } from './checkout';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, sleep, waitFor } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { countProcessed, countPublished, prepareWorld } from './outbox/demo-lib';
import { relayOnce } from './outbox/relay';

async function main(): Promise<void> {
  const { ds, buyerId, productId } = await prepareWorld('crash-relay');
  const consumer = await startConsumer({ dataSource: ds });
  const publisher = await EventPublisher.connect();

  const r = await checkout(ds, { buyerId, productId, quantity: 1, idempotencyKey: 'crash-relay-1' });
  if (!r.ok) throw new Error(`checkout: ${r.reason}`);

  // проход 1: relay-процес публікує й умирає між publish і UPDATE
  const child = fork(join(__dirname, 'outbox', 'relay-process.js'), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const seen: string[] = [];
  child.on('message', (m: { t: string }) => seen.push(m.t));
  const exited = new Promise<string | null>((res) => child.once('exit', (_c, signal) => res(signal)));
  await waitFor('relay опублікував (confirm від брокера)', () => seen.includes('published') || seen.includes('survived'));
  child.kill('SIGKILL'); // падіння між (A) publish і (B) UPDATE published_at
  const signal = await exited;

  const publishedAfterKill = await countPublished(ds);
  const [{ attempts }]: Array<{ attempts: number }> = await ds.query(`SELECT attempts FROM outbox`);

  // проход 2: relay рестартував. Зараз Postgres міг ще не звільнити лок мертвої
  // транзакції — SKIP LOCKED його просто пропустить, тому пробуємо, доки не винесе.
  let restarts = 0;
  await waitFor('рестартований relay виніс подію вдруге', async () => {
    restarts += 1;
    await relayOnce(ds, publisher);
    return (await countPublished(ds)) === 1;
  });
  await waitFor('дубль дійшов до консюмера', () => consumer.stats.delivered >= 2);
  await waitFor('усі ack', () => consumer.stats.acked >= 2);
  await sleep(300); // третьої доставки бути не повинно

  const published = await countPublished(ds);
  const deliveries = consumer.stats.delivered;
  const applied = consumer.stats.applied;
  const effect = await countEffects(ds);
  const processed = await countProcessed(ds);

  kv('published', published);
  kv('deliveries', deliveries);
  kv('applied', applied);
  kv('effect', effect);
  kv('processed', processed);
  kv('skipped', consumer.stats.skipped);
  kv('published_after_kill', publishedAfterKill);
  kv('attempts', attempts);
  kv('relay_restarts', restarts);

  await publisher.close();
  await consumer.close();
  await ds.destroy();

  const bad: string[] = [];
  if (signal !== 'SIGKILL' || seen.includes('survived')) bad.push(`relay не вбито (signal=${signal}): демо нічого не доводить`);
  if (publishedAfterKill !== 0) bad.push(`published_after_kill=${publishedAfterKill}: UPDATE встиг до kill`);
  if (published !== 1) bad.push(`published=${published}, очікувалось 1`);
  if (deliveries < 2) bad.push(`deliveries=${deliveries}: дубля не було`);
  if (applied !== 1) bad.push(`applied=${applied}, очікувалось 1`);
  if (effect !== 1) bad.push(`effect=${effect}, очікувалось 1`);
  if (processed !== 1) bad.push(`processed=${processed}, очікувалось 1`);
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
