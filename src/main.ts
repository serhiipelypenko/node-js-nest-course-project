import 'reflect-metadata';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { openApiErrorHandler } from './common/problem-json.middleware';
import { ProblemJsonFilter } from './common/problem-json.filter';

async function bootstrap() {
  // bodyParser: false — Nest реєструє свій express.json() лише всередині
  // init()/listen(), тобто ПІСЛЯ наших app.use() нижче. Валідатору JSON-тіло
  // потрібне вже розпарсеним, тож парсимо його самі, до валідатора.
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });
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
  // Коректне закриття пулу БД на SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // PORT береться з typed-конфіга (ConfigService<Env, true>), а не з
  // process.env напряму.
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`Marketplace API: http://localhost:${port}`);
}

// Зламаний конфіг = виняток з validate() -> сюди -> друкуємо причину і
// виходимо з ненульовим кодом. Саме це і є fail-fast на старті.
bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
