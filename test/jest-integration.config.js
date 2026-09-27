/**
 * Integration suite (testcontainers): тести репозиторіїв проти справжнього
 * Postgres. ts-jest замість ручного tsc->dist->jest з лекції 16 — ts-jest
 * теж прогонить файли через справжній компілятор TypeScript (не esbuild-
 * транспілятор), тож emitDecoratorMetadata працює так само, без другого
 * білд-кроку поверх того, що вже дає `nest build`.
 */
module.exports = {
  ...require('../jest.config'),
  testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
};
