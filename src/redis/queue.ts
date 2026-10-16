import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type Redis from 'ioredis';
import { connectWorker } from './clients';

// Черга BullMQ для роботи, яку не треба робити в HTTP-запиті (перерахунок
// рейтингу, лист, вебхук). Живе на ОКРЕМОМУ інстансі з noeviction + AOF: за
// документацією BullMQ, черга «cannot work properly if Redis evicts keys
// arbitrarily».

export const QUEUE_NAME = 'marketplace-jobs';
export const RECALC_RATING = 'recalc-rating';

export interface RecalcRatingData {
  productId: string;
  /** Тільки для демо/тестів: скільки перших спроб мають впасти. */
  failTimes?: number;
}

/**
 * Опції задачі за замовчуванням.
 *  - attempts ≥ 3 + exponential backoff з jitter: повтор не б'є по сусіду
 *    синхронно (той самий jitter, що в retry L#22);
 *  - removeOnComplete — {age}, НЕ true: `true` вимикає дедуплікацію за jobId
 *    (видалена задача більше не вважається дублікатом — прямо в документації).
 *    age мусить перекривати вікно, у якому можливий повтор add().
 */
export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 200, jitter: 0.5 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 24 * 3600 },
};

export function createQueue(connection: Redis): Queue {
  return new Queue(QUEUE_NAME, { connection });
}

/**
 * Поставити перерахунок рейтингу. jobId детермінований від продукту →
 * два add з тим самим jobId дають ОДНУ задачу (дедуплікація на стороні черги).
 */
export function enqueueRecalcRating(
  queue: Queue,
  data: RecalcRatingData,
  opts: JobsOptions = {},
): Promise<Job> {
  return queue.add(RECALC_RATING, data, {
    ...DEFAULT_JOB_OPTS,
    jobId: `${RECALC_RATING}-${data.productId}`,
    ...opts,
  });
}

/**
 * Планувальник — upsertJobScheduler, а не add: upsert ідемпотентний, і
 * кожен рестарт застосунку НЕ плодить дублікатів планувальника.
 * (repeatable-API в BullMQ 6 прибрано.)
 */
export function upsertScheduler(queue: Queue, id: string, everyMs: number, name: string) {
  return queue.upsertJobScheduler(id, { every: everyMs }, { name, opts: { removeOnComplete: true } });
}

export interface ProcessorDeps {
  /** Реальна робота: перерахувати рейтинг у базі й скинути картку в кеші. */
  recalcRating: (data: RecalcRatingData, job: Job) => Promise<void>;
  /** Планувальник: періодична задача (наприклад чистка протухлого). */
  onTick?: (job: Job) => Promise<void> | void;
}

/** Диспетчер за іменем задачі. Помилка = повтор за attempts/backoff. */
export function createProcessor(deps: ProcessorDeps) {
  return async (job: Job): Promise<void> => {
    if (job.name === RECALC_RATING) return deps.recalcRating(job.data as RecalcRatingData, job);
    if (job.name === 'tick') return void (await deps.onTick?.(job));
    throw new Error(`невідомий тип задачі: ${job.name}`);
  };
}

/** Worker із власним зʼєднанням maxRetriesPerRequest:null (інакше ламається на розриві звʼязку). */
export function createWorker(url: string, processor: (job: Job) => Promise<void>): Worker {
  const w = new Worker(QUEUE_NAME, processor, { connection: connectWorker(url, 'bullmq-worker') });
  w.on('error', (e) => console.error(`[worker] ${e.message}`));
  return w;
}
