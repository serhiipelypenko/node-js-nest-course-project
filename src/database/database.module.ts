import { readFile } from 'node:fs/promises';
import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.schema';

// Токен для інʼєкції пулу (клас Pool з 'pg' — не Nest-провайдер, тож потрібен
// рядковий токен + @Inject(PG_POOL)).
export const PG_POOL = 'PG_POOL';
// TypeORM DataSource для checkout() (транзакція на одному QueryRunner). Будується
// з ТОГО Ж DB_URL і файла з паролем, що й PG_POOL (шлях A у CLAUDE.md) — жодних
// DB_* зі шляху B. Сутностей і міграцій тут нема: лише сирі запити в транзакції.
export const DATA_SOURCE = 'DATA_SOURCE';

const logger = new Logger('DatabasePool');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('DB_URL', { infer: true }));
        const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });

        const pool = new Pool({
          host: url.hostname,
          port: url.port ? Number(url.port) : 5432,
          database: decodeURIComponent(url.pathname.replace(/^\//, '')),
          user: decodeURIComponent(url.username),
          // Пароль — ФУНКЦІЯ, а не рядок. pg викликає її на КОЖНЕ нове
          // зʼєднання, тож після ротації (новий вміст файла) наступний
          // конект іде вже з новим паролем — без рестарту процесу.
          password: async () =>
            (await readFile(passwordFile, 'utf8')).trim(),
        });

        // ОБОВʼЯЗКОВО. Коли rotate.sh робить pg_terminate_backend, Postgres
        // рве idle-зʼєднання пулу, і pg емітить 'error' на самому пулі.
        // Без цього обробника незловлена подія кладе процес — і це виглядає
        // як «ротація зламала сервіс», хоча насправді просто бракує handler-а.
        pool.on('error', (err) => {
          logger.warn(`idle-клієнт відвалився: ${err.message}`);
        });

        return pool;
      },
    },
    {
      provide: DATA_SOURCE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('DB_URL', { infer: true }));
        const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });
        const ds = new DataSource({
          type: 'postgres',
          host: url.hostname,
          port: url.port ? Number(url.port) : 5432,
          database: decodeURIComponent(url.pathname.replace(/^\//, '')),
          username: decodeURIComponent(url.username),
          // Як і в PG_POOL: функція, а не рядок — ротація пароля без рестарту.
          password: async () => (await readFile(passwordFile, 'utf8')).trim(),
          synchronize: false,
          entities: [],
        });
        await ds.initialize();
        // Той самий захист від падіння процесу на pg_terminate_backend під час ротації.
        (ds.driver as unknown as { master?: Pool }).master?.on('error', (err: Error) => {
          logger.warn(`idle-клієнт TypeORM відвалився: ${err.message}`);
        });
        return ds;
      },
    },
  ],
  exports: [PG_POOL, DATA_SOURCE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
