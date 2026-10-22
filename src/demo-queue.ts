// hw-23, demo:queue — BullMQ: дедуплікація за jobId, retry з backoff, планувальник.
import { queueRedisUrl } from './redis/config';
import { closeAll, configGet, connect } from './redis/clients';
import {
  createProcessor,
  createQueue,
  createWorker,
  enqueueRecalcRating,
  upsertScheduler,
} from './redis/queue';
import { bool, expect, info, kv, run, sleep } from './redis/demo-lib';

const SCHEDULER = 'demo-heartbeat';

run(async () => {
  const redis = connect(queueRedisUrl(), 'demo-queue');
  const queue = createQueue(redis);
  await queue.obliterate({ force: true }); // чистий аркуш: лише ключі цієї черги

  const policy = await configGet(redis, 'maxmemory-policy');
  kv('queue-noeviction', bool(policy === 'noeviction'));
  info(`maxmemory-policy=${policy} appendonly=${await configGet(redis, 'appendonly')}`);

  // Два add з тим самим jobId ДО старту воркера → у черзі одна задача.
  const data = { productId: '42', failTimes: 2 };
  const first = await enqueueRecalcRating(queue, data);
  const second = await enqueueRecalcRating(queue, data);
  kv('added', [first, second].length);
  expect(first.id === second.id, 'jobId не дедуплікував');
  kv('queued', await queue.count());

  let attempts = 0;
  let ticks = 0;
  let completed = 0;
  const worker = createWorker(
    queueRedisUrl(),
    createProcessor({
      // failTimes перших спроб падають — імітація сусіднього сервісу, що лежить
      recalcRating: async (d, job) => {
        attempts++;
        if (job.attemptsMade < (d.failTimes ?? 0)) throw new Error('сусідній сервіс лежить');
      },
      onTick: () => void ticks++,
    }),
  );
  worker.on('completed', (job) => {
    if (job.name !== 'tick') completed++;
  });

  const t0 = Date.now();
  while (completed < 1 && Date.now() - t0 < 15_000) await sleep(50);
  kv('attempts', attempts);
  kv('completed', completed);

  // Повторний add після завершення: removeOnComplete={age}, тому jobId ще «зайнятий» → дубліката немає.
  await enqueueRecalcRating(queue, { productId: '42' });
  kv('queued-after-complete', await queue.count());

  // Планувальник: upsert двічі (як після двох рестартів) → один планувальник.
  await upsertScheduler(queue, SCHEDULER, 500, 'tick');
  await upsertScheduler(queue, SCHEDULER, 500, 'tick');
  await sleep(3000);
  kv('schedulers', (await queue.getJobSchedulers()).length);
  kv('scheduled-runs', ticks);

  expect(attempts >= 3 && completed === 1, `attempts=${attempts} completed=${completed}`);
  expect(ticks >= 2, `scheduled-runs=${ticks}`);

  await queue.removeJobScheduler(SCHEDULER);
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await closeAll(redis);
});
