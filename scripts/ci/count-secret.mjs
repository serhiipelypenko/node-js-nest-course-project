#!/usr/bin/env node
// hw-32: скільки разів значення секрета застосунку трапилось у файлі (текстом і в base64). Друкує ЛИШЕ число.
//   APP_DB_PASSWORD=… node scripts/ci/count-secret.mjs deployment.json [ІМ'Я_ЗМІННОЇ]
// Значення знає раннер, грейдер — ні: тому рахує конвеєр, а в evidence.txt їде число (secret-in-manifest).
import { readFileSync } from 'node:fs';

const [file, name = 'APP_DB_PASSWORD'] = process.argv.slice(2);
const value = process.env[name];
if (!file || !value) {
  console.error(`використання: ${name}=… node count-secret.mjs <файл>; змінна ${name} має бути задана`);
  process.exit(2);
}
const text = readFileSync(file, 'utf8');
const count = (needle) => text.split(needle).length - 1;
console.log(count(value) + count(Buffer.from(value).toString('base64')));
