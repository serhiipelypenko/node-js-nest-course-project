import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';
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
  // openapi/openapi.yaml ДО того, як (і після того, як) до них доходить
  // Nest-контролер. Без validateResponses:true спека лишалась би
  // обіцянкою, яку ніхто не перевіряє.
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(__dirname, '..', 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
    }),
  );
  app.use(openApiErrorHandler);

  app.useGlobalFilters(new ProblemJsonFilter());

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`Marketplace API: http://localhost:${port}`);
}
bootstrap();
