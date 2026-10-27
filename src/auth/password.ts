import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEYLEN = 64;

// Формат: scrypt$<salt b64>$<key b64>. scrypt з дефолтними cost-параметрами
// Node (N=16384, r=8, p=1) — memory-hard, без нових залежностей.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Хеш-пустушка: при невідомому email все одно рахуємо scrypt, щоб час відповіді
// не розкривав, чи існує такий користувач.
let dummy: Promise<string> | undefined;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const hash = stored ?? (await (dummy ??= hashPassword('dummy-password-for-timing')));
  const [scheme, saltB64, keyB64] = hash.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  const match = timingSafeEqual(actual, expected);
  return stored !== null && match;
}
