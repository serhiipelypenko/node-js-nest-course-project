import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

// Cache-aside з TTL+джитером і single-flight локом проти stampede.
//
// Кеш — свідома угода про застарілі дані: ВІН НІКОЛИ НЕ ПОВИНЕН РОНЯТИ ЗАПИТ.
// Тому кожна операція з Redis тут обгорнута: недоступний/переповнений кеш
// (наприклад OOM на записі при noeviction) = просто промах, запит іде в базу.

export interface CacheOptions {
  /** Базовий TTL, с. */
  ttlSec: number;
  /** Розкид джитера, с: TTL = ttlSec + random(0..jitterSec). Інакше прогріте разом протухає разом. */
  jitterSec: number;
  /** Ввімкнути single-flight лок. false — наївний cache-aside (лише для порівняння в демо). */
  singleFlight: boolean;
  /** TTL самого лока, мс: має перекривати типовий час походу в базу. */
  lockMs: number;
  /** Скільки чекати лідера, мс, перш ніж піти в базу самому. */
  waitMs: number;
  /** Інтервал перечитування кеша очікувальником, мс. */
  pollMs: number;
}

export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
  ttlSec: 300,
  jitterSec: 60,
  singleFlight: true,
  lockMs: 5000,
  waitMs: 3000,
  pollMs: 20,
};

/** Compare-and-delete: зняти лок можна ТІЛЬКИ свій. Голий DEL знімає чужий (лок протух → його взяв інший). */
const UNLOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export function jitteredTtl(ttlSec: number, jitterSec: number): number {
  return ttlSec + Math.floor(Math.random() * (jitterSec + 1));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Усі помилки Redis → null/false: кеш деградує в «промах», а не в 500. */
async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.error(`[cache] ${(e as Error).message}`);
    return fallback;
  }
}

export class CacheAside<T> {
  private readonly opts: CacheOptions;

  constructor(
    private readonly redis: Redis,
    private readonly load: (key: string) => Promise<T | null>,
    opts: Partial<CacheOptions> = {},
  ) {
    this.opts = { ...DEFAULT_CACHE_OPTIONS, ...opts };
  }

  private async read(key: string): Promise<T | null> {
    const raw = await safe(() => this.redis.get(key), null);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  private async write(key: string, value: T): Promise<void> {
    const ttl = jitteredTtl(this.opts.ttlSec, this.opts.jitterSec);
    await safe(() => this.redis.set(key, JSON.stringify(value), 'EX', ttl), null);
  }

  /** Явна інвалідація — ДОДАТКОВО до TTL, а не замість нього. */
  async invalidate(key: string): Promise<void> {
    await safe(() => this.redis.del(key), 0);
  }

  async get(key: string): Promise<T | null> {
    const hit = await this.read(key);
    if (hit !== null) return hit;

    if (!this.opts.singleFlight) return this.fill(key);

    const token = randomUUID();
    const lockKey = `lock:${key}`;
    const got = await safe(
      () => this.redis.set(lockKey, token, 'PX', this.opts.lockMs, 'NX'),
      null,
    );

    if (got === 'OK') {
      try {
        // Подвійна перевірка: між нашим промахом і взяттям лока лідер-попередник
        // міг устигнути заповнити кеш і зняти лок — без цього був би зайвий похід.
        const again = await this.read(key);
        if (again !== null) return again;
        return await this.fill(key);
      } finally {
        await safe(() => this.redis.eval(UNLOCK_LUA, 1, lockKey, token), 0);
      }
    }

    // Лок у когось іншого: чекаємо й перечитуємо кеш.
    const deadline = Date.now() + this.opts.waitMs;
    while (Date.now() < deadline) {
      await sleep(this.opts.pollMs);
      const v = await this.read(key);
      if (v !== null) return v;
    }
    // Лідер не впорався (або Redis лежить) — деградуємо в похід у базу.
    // Лок — оптимізація: тут можливий зайвий SELECT, але не поламаний стан.
    return this.fill(key);
  }

  private async fill(key: string): Promise<T | null> {
    const value = await this.load(key);
    if (value !== null) await this.write(key, value);
    return value;
  }
}
