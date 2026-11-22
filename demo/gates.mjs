#!/usr/bin/env node
// hw-32 demo:gates — чотири сходинки якості, кожна ганяється ДВІЧІ тим самим інструментом, так само, як у конвеєрі:
// на коректному вході (-ok=0) і на зумисно зламаному (-broken≠0). Гейт, який завжди зелений, — не гейт.
//   types     tsc --noEmit + eslint            зламаний вхід: одруковка в типі (fixtures/types-broken)
//   contract  oasdiff breaking                 зламаний вхід: спека без обовʼязкового поля відповіді
//   arch      dependency-cruiser               зламаний вхід: заборонений імпорт products -> orders
//   image     npm run scan (поріг сканера)     зламаний вхід: SCAN_MAX=-1 (знахідок завжди більше)
// Коди виходу — реальні коди інструментів (жодних `|| true`). Вивід: рядки `<сходинка>-ok=` / `<сходинка>-broken=`.
// Без GitHub, без кластера. Потрібні: node, docker (лише для oasdiff, якщо немає локального бінарника).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.tmp-gates');

const log = (...a) => console.error(...a);
function run(label, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  const code = r.status ?? -1;
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n    ');
  log(`  [${label}] exit=${code}${tail ? `\n    ${tail}` : ''}`);
  return code;
}
const chain = (...codes) => codes.find((c) => c !== 0) ?? 0;

// ── входи для контракту: з РЕАЛЬНОЇ спеки ─────────────────────────────────────
const spec = readFileSync(join(ROOT, 'openapi/openapi.yaml'), 'utf8');
if (!spec.includes('example: 129900')) throw new Error('openapi.yaml змінилась: оновіть фікстури demo:gates');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
// сумісна зміна: нове НЕобовʼязкове поле у відповіді
writeFileSync(
  join(TMP, 'head-compatible.yaml'),
  spec.replace('example: 129900', 'example: 129900\n        currency:\n          type: string\n          description: Код валюти (необовʼязкове, додано сумісно).'),
);
// ламаюча зміна: price_cents перейменовано — клієнт на v1 лишається без обовʼязкового поля
writeFileSync(join(TMP, 'head-breaking.yaml'), spec.replaceAll('price_cents', 'price'));

const out = {};
try {
  log('→ types');
  out['types-ok'] = chain(
    run('tsc', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']),
    run('eslint', 'npm', ['run', '--silent', 'lint']),
  );
  const tscBroken = run('tsc/зламаний', 'npx', ['tsc', '--noEmit', '-p', 'fixtures/types-broken/tsconfig.json']);
  const lintBroken = run('eslint/зламаний', 'npx', ['eslint', 'fixtures/types-broken']);
  out['types-broken'] = chain(tscBroken, lintBroken);
  out['types-detail-tsc'] = tscBroken;
  out['types-detail-lint'] = lintBroken;

  log('→ contract');
  out['contract-ok'] = run('oasdiff', 'bash', ['scripts/ci/oasdiff.sh', 'openapi/openapi.yaml', '.tmp-gates/head-compatible.yaml']);
  out['contract-broken'] = run('oasdiff/зламаний', 'bash', ['scripts/ci/oasdiff.sh', 'openapi/openapi.yaml', '.tmp-gates/head-breaking.yaml']);

  log('→ arch');
  const depcruise = (dir) => run(`depcruise ${dir}`, 'npx', ['depcruise', '--no-progress', '--config', '.dependency-cruiser.cjs', dir]);
  out['arch-ok'] = depcruise('src');
  out['arch-broken'] = depcruise('fixtures/arch-broken/src');

  log('→ image (scan із підготовленим звітом сканера, без docker і мережі)');
  const scan = (max) => run(`scan SCAN_MAX=${max}`, 'node', ['scripts/scan.mjs'], { SCAN_REPORT: join(ROOT, 'fixtures/scan/trivy-report.json'), SCAN_MAX: String(max) });
  out['image-ok'] = scan(99999);
  out['image-broken'] = scan(-1);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
const bad = ['types', 'contract', 'arch', 'image'].filter((g) => out[`${g}-ok`] !== 0 || out[`${g}-broken`] === 0);
console.log(`one-sided-gates=${bad.length}`);
if (bad.length) log(`✗ однобічні сходинки: ${bad.join(', ')}`);
process.exit(bad.length === 0 ? 0 : 1);
