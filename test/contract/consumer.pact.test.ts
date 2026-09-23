import * as path from 'path';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';

const { like, regex } = MatchersV3;

/**
 * Consumer-сторона контракту (уявний фронтенд "marketplace-web") для
 * GET /products/{id} зі спеки #9 (openapi/openapi.yaml). Pact піднімає
 * мок-сервер із цього опису; результат — pacts/marketplace-web-marketplace-api.json.
 *
 * Матчери like()/regex() замість точних значень (task.md, «підказки») —
 * контракт не ламається від зміни конкретного товару в каталозі, важлива
 * лише ФОРМА відповіді.
 */
describe('Pact consumer · marketplace-web описує очікування від marketplace-api', () => {
  const provider = new PactV3({
    consumer: 'marketplace-web',
    provider: 'marketplace-api',
    dir: path.resolve(__dirname, '..', '..', 'pacts'),
  });

  test('GET /products/p1 за стану "product p1 exists"', async () => {
    provider
      .given('product p1 exists')
      .uponReceiving('запит товару p1')
      .withRequest({ method: 'GET', path: '/products/p1' })
      .willRespondWith({
        status: 200,
        headers: {
          'Content-Type': regex('application/json.*', 'application/json; charset=utf-8'),
        },
        body: {
          id: like('p1'),
          name: like('Клавіатура механічна'),
          price_cents: like(129900),
        },
      });

    await provider.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/products/p1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        price_cents: expect.any(Number),
      });
    });
  });
});
