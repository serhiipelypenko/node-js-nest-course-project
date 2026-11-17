// hw-31: спільні дрібниці скриптів demo/{failover,alb,nat}.mjs і scripts/aws-evidence-*.mjs.
// Правило те саме, що в hw-26/28/29: stdout — лише `ключ=число`, діагностика — у stderr.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGION = process.env.AWS_REGION ?? 'eu-central-1'; // збігається з aws:region у Pulumi.<stack>.yaml
export const EVIDENCE = join(ROOT, 'evidence');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const r1 = (x) => Math.round(x * 10) / 10;
export const note = (t) => console.error(`    ${t}`);

// 🔴 Ворота грошей — як у scripts/aws-env.sh.
export function realAwsGate(what) {
  if (process.env.HW31_REAL_AWS === '1') return;
  console.error(`SKIPPED: ${what} — потрібен справжній акаунт AWS. Увімкнути: HW31_REAL_AWS=1 npm run <скрипт>`);
  process.exit(0);
}

export function aws(args, region = REGION) {
  const out = execFileSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  return out.trim() ? JSON.parse(out) : {};
}
export function awsText(args, region = REGION) {
  return execFileSync('aws', [...args, '--region', region, '--output', 'text'], { encoding: 'utf8' }).trim();
}

// Бекенд стану: S3 у власному акаунті (той самий вибір, що в scripts/aws-env.sh).
export function pulumiEnv() {
  const account = awsText(['sts', 'get-caller-identity', '--query', 'Account']);
  const bucket = process.env.HW31_STATE_BUCKET ?? `hw31-pulumi-state-${account}`;
  return {
    ...process.env,
    AWS_REGION: REGION,
    PULUMI_SKIP_UPDATE_CHECK: 'true',
    PULUMI_BACKEND_URL: process.env.PULUMI_BACKEND_URL ?? `s3://${bucket}?region=${REGION}`,
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
  };
}
export const stackDir = (s) => join(ROOT, 'infra', s);

// pulumi з живим виводом у stderr (stdout лишається чистим для ключ=число).
export function pulumi(stack, args) {
  const t0 = Date.now();
  const r = spawnSync('pulumi', [...args, '--stack', stack], {
    cwd: stackDir(stack), env: pulumiEnv(), stdio: ['ignore', process.stderr, process.stderr],
  });
  if (r.status !== 0) { console.error(`✗ pulumi ${args.join(' ')} → exit ${r.status}`); process.exit(1); }
  return { seconds: (Date.now() - t0) / 1000 };
}
export function stackOutput(stack, key) {
  return execFileSync('pulumi', ['stack', 'output', key, '--stack', stack],
    { cwd: stackDir(stack), env: pulumiEnv(), encoding: 'utf8' }).trim();
}

// Звіт: ключі друкуються в stdout і зливаються у файл evidence (ключ=число, по рядку, без дублів).
export function mergeEvidence(file, map) {
  mkdirSync(EVIDENCE, { recursive: true });
  const path = join(EVIDENCE, file);
  const cur = new Map();
  if (existsSync(path)) for (const l of readFileSync(path, 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) cur.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const [k, v] of Object.entries(map)) cur.set(k, String(v));
  writeFileSync(path, [...cur].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
export function report(file, map) {
  for (const [k, v] of Object.entries(map)) console.log(`${k}=${v}`);
  if (file) mergeEvidence(file, map);
}

// Інваріанти: ✓/✗ у stderr, ненульовий код виходу при порушенні.
export function makeChecks() {
  let bad = 0;
  return {
    check(name, ok) { console.error(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) bad++; },
    finish() { if (bad) { console.error(`✗ порушено інваріантів: ${bad}`); process.exit(1); } },
  };
}
