import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../data-source';
import { QueryCountLogger } from '../query-count-logger';

// Спільне для demo:cache / demo:session / demo:ratelimit / demo:queue.
// Контракт виводу (читає грейдер): один рядок = ключ=число, ASCII, без пробілів.
export const kv = (key: string, value: number | string): void => console.log(`${key}=${value}`);
export const bool = (v: boolean): number => (v ? 1 : 0);
export const info = (msg: string): void => console.log(`# ${msg}`);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Перевірка інваріанту: порушений → exit ≠ 0 (демо не може «виглядати справним»). */
export function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ інваріант порушено: ${msg}`);
    process.exitCode = 1;
  }
}

/**
 * DataSource, що РАХУЄ запити на рівні драйвера (QueryCountLogger.count) —
 * db-calls не залежить від того, скільки разів викликали нашу функцію.
 */
export function countingDataSource(): { ds: DataSource; logger: QueryCountLogger } {
  const logger = new QueryCountLogger(['query']);
  const ds = new DataSource({ ...dataSourceOptions, logger, extra: { max: 60 } });
  return { ds, logger };
}

export function run(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
