// hw-19, demo:duplicate — доказ «at-least-once доставка + ідемпотентний ефект =
// exactly-once результат».
//
// Спосіб повторної доставки: справжній SIGKILL дочірнього процесу-споживача
// ПІСЛЯ ефекту, але ДО ack (пауза CONSUMER_GAP_MS). Брокер бачить обрив сокета й
// повертає unacked-повідомлення; другий споживач отримує його вдруге, INSERT ...
// ON CONFLICT DO NOTHING відкидає дубль.
import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { buildOrderPlaced } from './messaging/events';
import { startConsumer } from './messaging/consumer';
import { assertInvariant, countEffects, kv, queueDepths, resetState, waitFor } from './messaging/demo-lib';
import { EventPublisher } from './messaging/publisher';
import { DLQ, WORK_QUEUE } from './messaging/topology';

interface ChildMsg {
  t: 'ready' | 'recv' | 'effect' | 'skip' | 'acked';
  id?: string;
}

async function main(): Promise<void> {
  const ds = await resetState();

  const event = buildOrderPlaced({
    orderId: 'dup-demo-1',
    buyerId: 'u-dup',
    productId: 'p-dup',
    quantity: 1,
    totalAmount: 100,
  });

  const child = fork(join(__dirname, 'messaging', 'consumer-process.js'), {
    env: { ...process.env, CONSUMER_GAP_MS: '3000' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const seen: ChildMsg[] = [];
  child.on('message', (m: ChildMsg) => seen.push(m));
  const has = (t: ChildMsg['t']) => seen.some((x) => x.t === t);
  await waitFor('споживач-процес підписався', () => has('ready'));

  const publisher = await EventPublisher.connect();
  await publisher.publishOrderPlaced(event);

  await waitFor('ефект застосовано в дочірньому процесі', () => has('effect'));
  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  child.kill('SIGKILL'); // падіння між ефектом і ack
  await exited;
  const ackedBeforeKill = seen.filter((x) => x.t === 'acked').length;

  // другий споживач — отримує повернуте брокером повідомлення
  let redelivered = 0;
  const second = await startConsumer({
    dataSource: ds,
    hooks: { onRecv: (m) => (redelivered += m.redelivered ? 1 : 0) },
  });
  await waitFor('дубль оброблено й підтверджено', () => second.stats.acked >= 1);

  const deliveries = seen.filter((x) => x.t === 'recv').length + second.stats.delivered;
  const effect = await countEffects(ds);
  const skipped = second.stats.skipped;
  const [work, dlq] = await queueDepths([WORK_QUEUE, DLQ]);

  kv('deliveries', deliveries);
  kv('effect', effect);
  kv('skipped', skipped);
  kv('redelivered', redelivered);
  kv('work', work);
  kv('dlq', dlq);

  await publisher.close();
  await second.close();
  await ds.destroy();

  const bad: string[] = [];
  if (ackedBeforeKill !== 0) bad.push(`ack пройшов до SIGKILL (${ackedBeforeKill}): демо нічого не доводить`);
  if (deliveries < 2) bad.push(`deliveries=${deliveries}: дубля не було`);
  if (effect !== 1) bad.push(`effect=${effect}, очікувалось 1`);
  if (skipped !== 1) bad.push(`skipped=${skipped}, очікувалось 1`);
  if (work !== 0) bad.push(`work=${work}, очікувалось 0`);
  assertInvariant(bad);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
