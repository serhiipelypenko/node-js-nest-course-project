import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// Проєкт не вмикає esModuleInterop (див. import * as express у src/main.ts) —
// supertest експортує через `export =`, тому `import request from` дав би
// runtime-помилку (request_1.default is not a function).
import request = require('supertest');
import { startPg, PgHandle } from '../testkit/pg-container';

/**
 * E2E головної фічі курсового: створити замовлення -> прочитати його
 * (POST /orders -> GET /orders/:id), плюс два негативні кейси.
 *
 * ПОВНИЙ Nest-застосунок (Test.createTestingModule({ imports: [AppModule] }),
 * без підміни жодного провайдера) з ТІЄЮ Ж configureApp(), що й прод
 * (src/main.ts) — express-openapi-validator, ProblemJsonFilter тощо реально
 * стоять на місці, а не «десь у майбутньому e2e».
 *
 * БД — testcontainer: products/orders цього courseового API
 * тому запити нижче її не чіпають, але AppModule все одно
 * будує PG_POOL з DB_URL/DB_PASSWORD_FILE (DatabaseModule) — підсовуємо
 * туди справжній ефемерний Postgres, а не довільний рядок, щоб зібраний
 * DI-граф був СПРАВЖНІМ, а не тим, що випадково не впав через лінивість
 * pg.Pool.
 */
describe('E2E · POST /orders -> GET /orders/:id (supertest)', () => {
  let pg: PgHandle;
  let app: INestApplication;

  beforeAll(async () => {
    pg = await startPg('(e2e orders)');
    process.env.DB_URL = pg.dbUrlWithoutPassword;
    process.env.DB_PASSWORD_FILE = pg.passwordFile;

    // require, а НЕ import: ConfigModule.forRoot({ validate }) у
    // src/app.module.ts валідує process.env синхронно в момент першого
    // require() цього модуля — тож AppModule/main.ts мають бути required
    // ПІСЛЯ setPg()/присвоєння DB_URL вище, інакше падає з "DB_URL:
    // Required" ще на статичному import'і (так падало у CI без .env).
    const { AppModule } = require('../../src/app.module');
    const { configureApp, APP_OPTIONS } = require('../../src/main');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication(APP_OPTIONS));
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  test('happy path: POST /orders (Idempotency-Key) -> 201, GET /orders/:id -> 200 той самий запис', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', 'e2e-happy-path-1')
      .send({ items: [{ product_id: 'p1', quantity: 2 }] })
      .expect(201);

    expect(created.body).toMatchObject({
      items: [{ product_id: 'p1', quantity: 2 }],
      status: 'new',
    });
    expect(created.body.id).toEqual(expect.any(String));
    expect(created.headers.location).toBe(`/orders/${created.body.id}`);

    const fetched = await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(200);
    expect(fetched.body).toEqual(created.body);
  });

  test('невідоме замовлення -> 404 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/orders/does-not-exist').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404 });
  });

  test('без Idempotency-Key -> 400 problem+json ще до сервісу (валідатор спеки)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ items: [{ product_id: 'p1', quantity: 1 }] })
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.detail).toContain('idempotency-key');
  });
});
