/**
 * Contract (Pact): consumer.pact.test.ts генерує pacts/*.json,
 * provider.verify.test.ts верифікує його справжнім застосунком.
 * npm-скрипти обирають файл через --testPathPatterns=consumer|provider.verify.
 */
module.exports = {
  ...require('../jest.config'),
  testMatch: ['<rootDir>/test/contract/*.test.ts'],
};
