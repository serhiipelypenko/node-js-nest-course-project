#!/usr/bin/env node
// hw-28: сканування образу з ОБЧИСЛЮВАНИМ порогом.
//
// Вердикт рахується з даних: звіт сканера -> кількість знахідок -> порівняння з SCAN_MAX.
// Друкує image=, severity=, found=, max-allowed=, gate=pass|fail; exit 0 / 1.
//
//   SCAN_MAX=-1    npm run scan   # gate=fail, exit 1 (знахідок завжди > -1)
//   SCAN_MAX=99999 npm run scan   # gate=pass, exit 0
//
// Змінні: SCAN_IMAGE (marketplace-api:hw28), SCAN_SEVERITY (CRITICAL,HIGH),
// SCAN_MAX (робочий поріг нижче), SCAN_IGNORE_UNFIXED (1 — рахуємо лише знахідки з
// виправленням), SCAN_REPORT (готовий JSON-звіт trivy замість запуску сканера).
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRIVY_IMAGE = 'aquasec/trivy:0.74.0';
const CACHE_VOLUME = 'hw28-trivy-cache';
// Робочий поріг CI: верхня межа виправних CRITICAL+HIGH (виміряно 7 на distroless nodejs22). База сканера
// оновлюється щодоби, тож це бюджет, а не «нуль»; піднімати його треба свідомо, з PR.
const DEFAULT_MAX = 10;

const image = process.env.SCAN_IMAGE ?? 'marketplace-api:hw28';
const severity = process.env.SCAN_SEVERITY ?? 'CRITICAL,HIGH';
const ignoreUnfixed = (process.env.SCAN_IGNORE_UNFIXED ?? '1') === '1';
const rawMax = process.env.SCAN_MAX ?? String(DEFAULT_MAX);
const max = Number(rawMax);
if (!Number.isInteger(max)) {
  console.error(`SCAN_MAX має бути цілим числом, а не "${rawMax}"`);
  process.exit(2);
}

function loadReport() {
  if (process.env.SCAN_REPORT) return JSON.parse(readFileSync(process.env.SCAN_REPORT, 'utf8'));
  const args = ['--quiet', 'image', '--scanners', 'vuln', '--format', 'json', '--severity', severity];
  if (ignoreUnfixed) args.push('--ignore-unfixed');
  args.push(image);

  const local = spawnSync('trivy', ['--version'], { encoding: 'utf8' });
  let r;
  if (local.status === 0) {
    r = spawnSync('trivy', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } else {
    spawnSync('docker', ['volume', 'create', CACHE_VOLUME], { encoding: 'utf8' });
    r = spawnSync(
      'docker',
      ['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${CACHE_VOLUME}:/root/.cache/`, TRIVY_IMAGE, ...args],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  }
  if (r.status !== 0) {
    console.error(`сканер завершився з кодом ${r.status}\n${(r.stderr || '').slice(-600)}`);
    process.exit(2);
  }
  return JSON.parse(r.stdout);
}

const report = loadReport();
const wanted = new Set(severity.split(',').map((s) => s.trim().toUpperCase()));
let found = 0;
for (const res of report.Results ?? []) {
  for (const v of res.Vulnerabilities ?? []) {
    if (wanted.has(String(v.Severity).toUpperCase())) found += 1;
  }
}

const pass = found <= max;
console.log(`image=${image}`);
console.log(`severity=${severity}`);
console.log(`found=${found}`);
console.log(`max-allowed=${max}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
process.exit(pass ? 0 : 1);
