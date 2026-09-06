#!/usr/bin/env node
// Звіряє .env.example зі src/config/env.schema.ts.
//
// Ідея: .env.example — це контракт у git. Він мусить містити РІВНО ті самі
// ключі, що й zod-схема: жодного зайвого, жодного пропущеного. Якщо хтось
// додав змінну в схему й забув у .env.example (або навпаки) — цей скрипт
// падає з exit 1 і називає розбіжність.
'use strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

// 1. Ключі зі схеми: рядки виду `  NODE_ENV: z.…`
const schemaSrc = readFileSync(
  join(root, 'src', 'config', 'env.schema.ts'),
  'utf8',
);
const schemaKeys = new Set(
  [...schemaSrc.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*z\b/gm)].map((m) => m[1]),
);

// 2. Ключі з .env.example: рядки виду `NAME=…`, коментарі (#) і порожні — пропускаємо
const exampleSrc = readFileSync(join(root, '.env.example'), 'utf8');
const exampleKeys = new Set(
  exampleSrc
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim())
    .filter(Boolean),
);

// 3. Порівняння
const missing = [...schemaKeys].filter((k) => !exampleKeys.has(k));
const extra = [...exampleKeys].filter((k) => !schemaKeys.has(k));

if (missing.length === 0 && extra.length === 0) {
  console.log(
    `OK: .env.example синхронний зі схемою (${schemaKeys.size} змінних)`,
  );
  process.exit(0);
}

console.error('FAIL: .env.example розійшовся з env.schema.ts');
if (missing.length) {
  console.error(`  немає в .env.example: ${missing.join(', ')}`);
}
if (extra.length) {
  console.error(`  зайве в .env.example (немає у схемі): ${extra.join(', ')}`);
}
process.exit(1);
