import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// Проєкт не вмикає esModuleInterop (див. import * as express у src/main.ts) —
// supertest експортує через `export =`, тому `import request from` дав би
// runtime-помилку (request_1.default is not a function).
import request = require('supertest');
import { randomUUID } from 'node:crypto';
import { setAuthEnv } from '../testkit/auth-env';
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
 * БД — testcontainer зі СПРАВЖНЬОЮ схемою (ті самі міграції). Контур іде
 * через Postgres: POST /orders -> checkout() (склад, баланс, замовлення, outbox
 * в одній транзакції) -> GET /orders/:id читає з таблиць. Покупці й товар
 * створюються прямо в БД у beforeAll — як це зробив би seed.
 */
describe('E2E · POST /orders -> GET /orders/:id (supertest)', () => {
  let pg: PgHandle;
  let app: INestApplication;
  // hw-24: усе, крім каталогу, закрите Bearer-токеном. Токени карбуємо тим
  // самим TokenService, що й застосунок (логін не потрібен — тут тестується
  // замовлення, а не автентифікація; її покриває demo:auth/reuse/rbac).
  let bearer: (userId: string, role?: 'customer' | 'seller' | 'admin') => string;
  let buyer: string; // id покупців і товару — реальні bigint з БД (як рядки в API)
  let stranger: string;
  let productId: string;

  beforeAll(async () => {
    pg = await startPg('(e2e orders)');
    process.env.DB_URL = pg.dbUrlWithoutPassword;
    process.env.DB_PASSWORD_FILE = pg.passwordFile;
    setAuthEnv();

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

    const user = async (email: string) =>
      (await pg.pool.query(`INSERT INTO users (email, full_name) VALUES ($1, $1) RETURNING id::text`, [email])).rows[0].id as string;
    buyer = await user('e2e-buyer@test');
    stranger = await user('e2e-stranger@test');
    productId = (
      await pg.pool.query(
        `INSERT INTO products (sku, name, price, stock) VALUES ('e2e-sku', 'E2E товар', 1299.00, 100) RETURNING id::text`,
      )
    ).rows[0].id as string;

    const { TokenService } = require('../../src/auth/token.service');
    const tokens = app.get(TokenService);
    bearer = (userId, role = 'customer') => `Bearer ${tokens.sign(userId, role, randomUUID()).token}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  test('happy path: POST /orders (Idempotency-Key) -> 201, GET /orders/:id -> 200 той самий запис', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', bearer(buyer))
      .set('Idempotency-Key', 'e2e-happy-path-1')
      .send({ items: [{ product_id: productId, quantity: 2 }] })
      .expect(201);

    expect(created.body).toMatchObject({
      items: [{ product_id: productId, quantity: 2 }],
      status: 'new',
    });
    expect(created.body.id).toEqual(expect.any(String));
    expect(created.headers.location).toBe(`/orders/${created.body.id}`);

    const fetched = await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .set('Authorization', bearer(buyer))
      .expect(200);
    expect(fetched.body).toEqual(created.body);
    expect(created.body.total_cents).toBe(129900 * 2);

    // Дані ПОСТІЙНІ: замовлення — це рядок у БД, а не елемент масиву в процесі,
    // і подія лежить в outbox тією самою транзакцією.
    const { rows: db } = await pg.pool.query(
      `SELECT (SELECT count(*) FROM orders WHERE id = $1)::int AS orders,
              (SELECT stock FROM products WHERE id = $2) AS stock,
              (SELECT count(*) FROM outbox WHERE aggregate_id = $1::text)::int AS outbox`,
      [created.body.id, productId],
    );
    expect(db[0]).toEqual({ orders: 1, stock: 98, outbox: 1 });
    expect(fetched.body.buyer_id).toBe(buyer); // власник — sub токена, не поле з тіла
  });

  test('401 ≠ 403: без токена -> 401, чужий валідний токен -> 403', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', bearer(buyer))
      .set('Idempotency-Key', 'e2e-owner-1')
      .send({ items: [{ product_id: productId, quantity: 1 }] })
      .expect(201);

    const anon = await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    expect(anon.headers['www-authenticate']).toBe('Bearer');

    await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .set('Authorization', bearer(stranger))
      .expect(403);
  });

  test('Idempotency-Key: повтор того ж ключа не дає другого замовлення і другого списання', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', bearer(buyer))
        .set('Idempotency-Key', 'e2e-idem-1')
        .send({ items: [{ product_id: productId, quantity: 1 }] })
        .expect(201);
    const [stockBefore] = (await pg.pool.query(`SELECT stock FROM products WHERE id = $1`, [productId])).rows;
    const first = await send();
    const second = await send();
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const [stockAfter] = (await pg.pool.query(`SELECT stock FROM products WHERE id = $1`, [productId])).rows;
    expect(stockBefore.stock - stockAfter.stock).toBe(1); // списано один раз
  });

  test('бізнес-правило: нестача на складі -> 409 problem+json, транзакція відкочена', async () => {
    const before = (await pg.pool.query(`SELECT stock FROM products WHERE id = $1`, [productId])).rows[0].stock;
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', bearer(buyer))
      .set('Idempotency-Key', 'e2e-oversell-1')
      .send({ items: [{ product_id: productId, quantity: 1_000_000 }] })
      .expect(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const after = (await pg.pool.query(`SELECT stock FROM products WHERE id = $1`, [productId])).rows[0].stock;
    expect(after).toBe(before);
  });

  test('невідоме замовлення -> 404 problem+json', async () => {
    const res = await request(app.getHttpServer())
      .get('/orders/does-not-exist')
      .set('Authorization', bearer(buyer))
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404 });
  });

  test('без Idempotency-Key -> 400 problem+json ще до сервісу (валідатор спеки)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', bearer(buyer))
      .send({ items: [{ product_id: productId, quantity: 1 }] })
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.detail).toContain('idempotency-key');
  });
});
