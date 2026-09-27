/** E2E (supertest): повний Nest-застосунок проти testcontainers Postgres. */
module.exports = {
  ...require('../jest.config'),
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
};
