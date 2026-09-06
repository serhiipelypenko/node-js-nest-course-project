import { readFile } from 'node:fs/promises';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Env } from '../config/env.schema';

// Токен для інʼєкції пулу (клас Pool з 'pg' — не Nest-провайдер, тож потрібен
// рядковий токен + @Inject(PG_POOL)).
export const PG_POOL = 'PG_POOL';

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
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
