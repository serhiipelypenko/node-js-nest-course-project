import { generateKeyPairSync } from 'node:crypto';

/**
 * hw-24: AppModule тепер вимагає ключ підпису й «перець» (env.schema.ts, без
 * дефолтів). Тестам реальний ключ зі сховища не потрібен — як і грейдеру:
 * застосунку байдуже, чия пара, аби вона була валідна. Генеруємо одноразову
 * ES256-пару в памʼяті й кладемо в process.env ДО першого require('app.module').
 */
export function setAuthEnv(): void {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');
  process.env.JWT_KID = 'test';
  process.env.REFRESH_TOKEN_PEPPER = 'test-pepper';
  // hw-26: сховище файлів теж обовʼязкове в схемі; тести його не чіпають (фейкові значення)
  process.env.STORAGE_ACCESS_KEY ??= 'test';
  process.env.STORAGE_SECRET_KEY ??= 'test-secret';
  process.env.STORAGE_BUCKET ??= 'test-bucket';
}
