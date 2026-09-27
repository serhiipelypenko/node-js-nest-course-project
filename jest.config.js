/**
 * Спільна база для test/jest-integration.config.js / jest-e2e.config.js /
 * jest-contract.config.js (кожен додає лише свій testMatch).
 *
 * reporters: ['default'] — без цього рядка Jest 30 сам вибирає репортер за
 * змінними оточення (detectAgent() у @jest/core) і в частині середовищ
 * запуску ховає PASS <файл>, назви describe/it і ✓ (task.md, п.8). Один
 * рядок, тут, успадковується усіма трьома конфігами нижче.
 */
module.exports = {
  rootDir: __dirname,
  // secrets/ містить кілька окремих lecture-проєктів зі своїми package.json
  // (колізія "name" між 15_PoolingReplicasSharding і _v2) — без roots jest
  // сканує їх у haste-map і друкує "Haste module naming collision".
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
  reporters: ['default'],
  testTimeout: 120_000,
  maxWorkers: 1, // кожен jest-воркер підняв би СВІЙ контейнер (task.md, порада з лекції)
  verbose: true,
};
