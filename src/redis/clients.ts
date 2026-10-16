import Redis from 'ioredis';

/**
 * Клієнт для запитів «запит-відповідь» (кеш, сесії, ліміт, Queue).
 * Без 'error'-хендлера ioredis кидає unhandled 'error' і валить процес — як і
 * pg.Pool у database.module.ts; тому слухач обовʼязковий.
 */
export function connect(url: string, name: string): Redis {
  const r = new Redis(url, { connectionName: name, maxRetriesPerRequest: 2 });
  r.on('error', (e) => console.error(`[redis:${name}] ${e.message}`));
  return r;
}

/**
 * Клієнт для BullMQ Worker: maxRetriesPerRequest МУСИТЬ бути null, інакше на
 * розриві звʼязку ioredis кине виняток і воркер зламається замість того, щоб
 * дочекатись Redis. Для Queue навпаки — падати швидко правильно (connect()).
 */
export function connectWorker(url: string, name: string): Redis {
  const r = new Redis(url, { connectionName: name, maxRetriesPerRequest: null });
  r.on('error', (e) => console.error(`[redis:${name}] ${e.message}`));
  return r;
}

export async function closeAll(...clients: Array<Redis | undefined>): Promise<void> {
  await Promise.all(clients.map((c) => c?.quit().catch(() => undefined)));
}

/** Значення одного параметра CONFIG GET (ioredis віддає плаский масив). */
export async function configGet(r: Redis, name: string): Promise<string> {
  const pairs = (await r.config('GET', name)) as unknown as string[];
  return pairs[1] ?? '';
}
