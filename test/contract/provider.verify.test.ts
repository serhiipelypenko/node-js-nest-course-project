import 'reflect-metadata';
import * as path from 'path';
import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import { Verifier, VerifierOptions } from '@pact-foundation/pact';
import { startPg, PgHandle } from '../testkit/pg-container';

const PROVIDER_PORT = 3701;
const PROVIDER_NAME = 'marketplace-api';
const CONSUMER_NAME = 'marketplace-web';
const LOCAL_PACT_FILE = path.resolve(__dirname, '..', '..', 'pacts', `${CONSUMER_NAME}-${PROVIDER_NAME}.json`);

// process.env, а не константа в коді (task.md, п.6): локально дефолт на
// власний compose (не секрет), у CI/production — з GitHub secrets.
const BROKER_URL = process.env.PACT_BROKER_URL;
const BROKER_TOKEN = process.env.PACT_BROKER_TOKEN;

/**
 * Provider verification: СПРАВЖНІЙ marketplace-api (createApp() з src/main.ts
 * — та сама configureApp(), що й прод) відповідає на кожну взаємодію
 * консюмерського контракту.
 *
 * Дві гілки під ОДНИМ npm-скриптом verify:provider:
 *  - без PACT_BROKER_URL   -> локальний файл pacts/*.json (базовий критерій);
 *  - з PACT_BROKER_URL     -> контракт із брокера + publishVerificationResult:
 *    true (той самий виклик, яким користується CI-джоба contract і локальний
 *    гейт can-i-deploy у README).
 *
 * stateHandlers тут НЕ сідять БД: products/orders цього API,
 * товар "p1" завжди присутній у каталозі за задумом hw-09.
 * pg піднімається все одно — DatabaseModule (DB_URL/DB_PASSWORD_FILE) має
 * бути справжнім, щоб DI-граф збирався так само, як у проді.
 */
describe('Pact provider verification · marketplace-api проти контракту', () => {
  let pg: PgHandle;
  let app: INestApplication;

  beforeAll(async () => {
    pg = await startPg('(contract provider)');
    process.env.DB_URL = pg.dbUrlWithoutPassword;
    process.env.DB_PASSWORD_FILE = pg.passwordFile;

    // require, а НЕ import: ConfigModule.forRoot({ validate }) у
    // src/app.module.ts валідує process.env синхронно в момент першого
    // require() цього модуля (а не пізніше, коли Nest будує DI-граф) — тож
    // якщо взяти createApp() статичним import'ом на верху файлу, він
    // виконається ДО setPg()/присвоєння DB_URL вище і впаде з "DB_URL:
    // Required" (саме так і падало у CI, де немає .env з дефолтним DB_URL).
    const { createApp } = require('../../src/main');
    app = await createApp();
    await app.listen(PROVIDER_PORT);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  test(`усі взаємодії контракту пройдено${BROKER_URL ? ' (з брокера)' : ' (локальний файл)'}`, async () => {
    const stateHandlers = {
      'product p1 exists': async () => {
        // no-op: каталог in-memory (src/products/products.service.ts) — p1 у ньому завжди є.
      },
    };

    const verifierOptions: VerifierOptions = BROKER_URL
      ? {
          provider: PROVIDER_NAME,
          providerBaseUrl: `http://127.0.0.1:${PROVIDER_PORT}`,
          pactBrokerUrl: BROKER_URL,
          ...(BROKER_TOKEN ? { pactBrokerToken: BROKER_TOKEN } : {}),
          publishVerificationResult: true,
          providerVersion: process.env.PROVIDER_VERSION ?? '1.0.0',
          providerVersionBranch: process.env.GITHUB_REF_NAME ?? 'main',
          consumerVersionSelectors: [{ latest: true }],
          stateHandlers,
          logLevel: 'warn',
        }
      : {
          provider: PROVIDER_NAME,
          providerBaseUrl: `http://127.0.0.1:${PROVIDER_PORT}`,
          pactUrls: [LOCAL_PACT_FILE],
          stateHandlers,
          logLevel: 'warn',
        };

    if (!BROKER_URL) {
      expect(fs.existsSync(LOCAL_PACT_FILE)).toBe(true); // спершу npm run test:contract (consumer!)
    }

    const output = await new Verifier(verifierOptions).verifyProvider();
    console.log('verifier:', output);
  });
});
