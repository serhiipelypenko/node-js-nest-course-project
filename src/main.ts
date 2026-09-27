import 'reflect-metadata';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { openApiErrorHandler } from './common/problem-json.middleware';
import { ProblemJsonFilter } from './common/problem-json.filter';

// bodyParser: false — Nest реєструє свій express.json() лише всередині
// init()/listen(), тобто ПІСЛЯ app.use() у configureApp() нижче. Валідатору
// JSON-тіло потрібне вже розпарсеним, тож парсимо його самі, до валідатора.
// Той самий прапорець потрібен і в E2E (hw-16): createNestApplication() бере
// його другим аргументом.
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

// Спільна конфігурація застосунку (мідлвари, валідатор, фільтр помилок) —
// винесена окремо від створення DI-графа (createApp), щоб hw-16 могла
// застосувати ЦІ САМІ налаштування і до застосунку з NestFactory.create()
// (прод), і до застосунку з Test.createTestingModule().createNestApplication()
// (E2E supertest) — інакше E2E тестує інший застосунок, ніж прод.
export function configureApp(app: INestApplication): INestApplication {
  app.use(express.json());

  // Кордон контракту: кожен запит і кожна відповідь звіряються з
  // openapi/openapi.yaml. ignoreUndocumented: true — щоб операційні
  // маршрути (/health, /health/db), яких у спеці немає, проходили без
  // валідаторного 404.
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(__dirname, '..', 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
      ignoreUndocumented: true,
    }),
  );
  app.use(openApiErrorHandler);

  app.useGlobalFilters(new ProblemJsonFilter());
  // Коректне закриття пулу БД на SIGTERM/SIGINT (і на app.close() у тестах).
  app.enableShutdownHooks();

  return app;
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    ...APP_OPTIONS,
  });
  return configureApp(app);
}

async function bootstrap() {
  const app = await createApp();

  // PORT береться з typed-конфіга (ConfigService<Env, true>), а не з
  // process.env напряму.
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`Marketplace API: http://localhost:${port}`);
}

// Запуск напряму (node dist/main.js): не при імпорті createApp/configureApp
// з тестів (hw-16 E2E/contract), а лише коли цей файл — точка входу процесу.
if (require.main === module) {
  // Зламаний конфіг = виняток з validate() -> сюди -> друкуємо причину і
  // виходимо з ненульовим кодом. Саме це і є fail-fast на старті.
  bootstrap().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
