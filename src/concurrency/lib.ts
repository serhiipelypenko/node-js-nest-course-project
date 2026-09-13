// Спільні дрібниці для демо конкурентності hw-14 (demo-race/demo-workers/
// demo-retry) — той самий патерн, що лекційний src/lib/db.ts
// (14_TransactionsSqlOpt), тільки на DataSource цього проєкту
// замість окремого pg.Pool: підключення й так уже налаштоване на hw-11–13
// (scripts/with-secrets.sh + src/data-source.ts), нового каналу не додаємо.
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../data-source';

// Дефолтний пул TypeORM (max: 10) занадто малий для demo:race — 50+
// одночасних чекаутів = 50+ одночасних з'єднань. Піднімаємо max замість
// того, щоб чекати в черзі пулу
export function createDataSource(maxConnections = 60): DataSource {
  return new DataSource({ ...dataSourceOptions, extra: { max: maxConnections } });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface PgError extends Error {
  code?: string;
}

export const asPgError = (e: unknown): PgError => e as PgError;

export const log = (tag: string, msg: string): void => console.log(`  [${tag}] ${msg}`);
export const hdr = (title: string): void => console.log(`\n━━━ ${title} ━━━`);
export const note = (msg: string): void => console.log(`      ${msg}`);

// serialization_failure, deadlock_detected — єдині два коди, які має сенс
// повторювати: обидва означають "транзакція коректна, повтори її цілком",
// а не "запит помилковий" (те й відрізняє їх від решти помилок Postgres).
const RETRYABLE_CODES = new Set(['40001', '40P01']);

/**
 * Повторює ЦІЛУ транзакцію під REPEATABLE READ, якщо Postgres відповів
 * 40001/40P01. Читання всередині fn мають бути частиною тієї самої
 * транзакції (той самий QueryRunner) — повтор тільки запису був би
 * lost update у профіль
 */
export async function withRetry<T>(
  label: string,
  dataSource: DataSource,
  fn: (qr: QueryRunner) => Promise<T>,
  maxAttempts = 8,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction('REPEATABLE READ');
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      const err = asPgError(e);
      if (err.code !== undefined && RETRYABLE_CODES.has(err.code) && attempt < maxAttempts) {
        const backoff = Math.round(2 ** attempt * 20 + Math.random() * 20);
        log(label, `спроба ${attempt} впала: ${err.code} (${err.message}) → retry через ${backoff} мс`);
        await sleep(backoff);
        continue;
      }
      throw e;
    } finally {
      await qr.release();
    }
  }
}
