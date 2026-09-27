import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Pool } from 'pg';
import { dataSourceOptions } from '../../src/data-source';

// dataSourceOptions типізовано широким union DataSourceOptions (drivers, яких
// цей проєкт не використовує). Extract звужує до варіанта "postgres", інакше
// spread у fresh object literal нижче ловить надлишкову перевірку властивостей
// проти НЕпов'язаного члена union (напр. SqliteConnectionOptions) — типова
// пастка TS із union-типами таргета для object literal.
type PostgresDataSourceOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * Один виклик = один справжній Postgres у Docker (testcontainers). Схему
 * накочуємо ТИМИ Ж міграціями (dist/migrations/*.js — з src/data-source.ts),
 * якими hw-13/14 накочують dev/prod базу: synchronize:false лишається
 * правдою і для тестової бази.
 *
 * `npm run build` мусить відбутися ДО запуску тестів, що це імпортують —
 * саме тому test:integration/test:e2e/test:contract/verify:provider
 * у package.json починаються з `npm run build`.
 */
export interface PgHandle {
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
  /** окремий pg.Pool — для raw SQL (TRUNCATE між тестами, stateHandlers Pact) */
  pool: Pool;
  /** повний DSN з паролем — testcontainers сам обирає ефемерний хост-порт */
  uri: string;
  /**
   * DSN БЕЗ пароля — саме такий формат читає застосунок з DB_URL
   * (src/config/env.schema.ts): host/port/db/user тут, пароль — окремим
   * файлом (passwordFile), який pg.Pool перечитує на кожне з'єднання
   * (src/database/database.module.ts). Підсовуємо тестовий контейнер у ці
   * самі дві змінні, щоб E2E піднімав СПРАВЖНІЙ AppModule без підміни
   * провайдерів.
   */
  dbUrlWithoutPassword: string;
  passwordFile: string;
  /** TRUNCATE усіх таблиць домену — стратегія ізоляції між тестами всередині файла (див. README) */
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

const DOMAIN_TABLES = ['job_queue', 'order_items', 'orders', 'products', 'users'];

export async function startPg(label = ''): Promise<PgHandle> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const dataSource = new DataSource({
    ...(dataSourceOptions as PostgresDataSourceOptions),
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  });
  await dataSource.initialize();
  await dataSource.runMigrations();

  const pool = new Pool({ connectionString: container.getConnectionUri() });

  const tmpDir = await mkdtemp(join(tmpdir(), 'hw16-db-password-'));
  const passwordFile = join(tmpDir, `${randomUUID()}.txt`);
  await writeFile(passwordFile, container.getPassword(), 'utf8');

  const dbUrlWithoutPassword = `postgres://${encodeURIComponent(container.getUsername())}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;

  // eslint-disable-next-line no-console
  console.log(`[testkit] postgres:16-alpine${label ? ' ' + label : ''} готовий → ${dbUrlWithoutPassword}`);

  return {
    container,
    dataSource,
    pool,
    uri: container.getConnectionUri(),
    dbUrlWithoutPassword,
    passwordFile,
    async truncateAll() {
      await pool.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    },
    async stop() {
      await pool.end();
      await dataSource.destroy();
      await container.stop();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}
