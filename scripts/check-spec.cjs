#!/usr/bin/env node
// Перевіряє обсяг зібраної спеки (spec.json з `npm run bundle:spec`) проти
// acceptance criteria ДЗ №9: >=2 ресурси, >=5 операцій, Idempotency-Key —
// header-параметр required: true з описом семантики повтору (>=40 символів).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const specPath = path.join(process.cwd(), 'spec.json');
if (!fs.existsSync(specPath)) {
  console.error(
    `Не знайдено ${specPath}. Спочатку прогони: npx @redocly/cli bundle openapi/openapi.yaml -o spec.json`,
  );
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const ops = Object.entries(spec.paths).flatMap(([p, v]) =>
  Object.keys(v)
    .filter((m) => METHODS.includes(m))
    .map((m) => [p, m]),
);

const resources = new Set(Object.keys(spec.paths).map((p) => p.split('/')[1]));

const idem = ops
  .flatMap(([p, m]) => spec.paths[p][m].parameters ?? [])
  .find((x) => x.in === 'header' && /idempotency-key/i.test(x.name));

const descLength = (idem?.description ?? '').trim().length;

console.log(`операцій: ${ops.length} · ресурсів: ${resources.size}`);
console.log(`Idempotency-Key: required = ${idem?.required} · опис, символів = ${descLength}`);

const failures = [];
if (ops.length < 5) failures.push(`операцій ${ops.length} < 5`);
if (resources.size < 2) failures.push(`ресурсів ${resources.size} < 2`);
if (idem?.required !== true) failures.push('Idempotency-Key не задекларовано як required: true');
if (descLength < 40) failures.push(`опис Idempotency-Key закороткий: ${descLength} < 40 символів`);

if (failures.length) {
  console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

console.log('\nOK: обсяг спеки відповідає acceptance criteria');
