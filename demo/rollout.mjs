#!/usr/bin/env node
// hw-28 demo:rollout — rolling update під навантаженням. ГОЛОВНИЙ вимір ДЗ.
//
//   node demo/rollout.mjs             # профіль good: requests/ok/failed/rollout-seconds
//   node demo/rollout.mjs --compare   # спершу bad (ключі з префіксом bad-), потім good
//
// requests/ok/failed РАХУЮТЬСЯ з файла, у який генератор пише код кожної відповіді
// (scripts/load.sh). «Не 200» = failed: у NodePort напряму збій — це curl-код 000
// (відповіді не було), а не HTTP 5xx; за Ingress/ALB те саме стало б 502/503.
// Стан кластера після демо — профіль good (прибираємо за собою).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_URL, log, out, sh, sleep, waitRolledOut } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_REQUESTS = Number(process.env.MIN_REQUESTS ?? 5000); // нижче — вимір порожній
const WORKERS = Number(process.env.LOAD_WORKERS ?? 4);
const MIN_LOAD_S = 30;
const MAX_LOAD_S = 240;

function pulumi(...args) {
  const r = sh('bash', [join(ROOT, 'scripts/pulumi.sh'), ...args]);
  if (r.code !== 0) throw new Error(`pulumi ${args.join(' ')}: ${(r.err || r.out).slice(-1200)}`);
}
const setConfig = (k, v) => pulumi('config', 'set', k, String(v));

async function waitHttp200(timeoutS = 90) {
  for (let i = 0; i < timeoutS; i++) {
    const r = sh('curl', ['-s', '-o', '/dev/null', '--max-time', '2', '-w', '%{http_code}', SERVICE_URL]);
    if (r.out === '200') return;
    await sleep(1000);
  }
  throw new Error(`${SERVICE_URL} не відповів 200 за ${timeoutS} с`);
}

async function runOnce(profile) {
  const stamp = Date.now();
  // 1. базовий стан потрібного профілю
  setConfig('profile', profile);
  setConfig('rev', `${profile}-${stamp}-a`);
  pulumi('up');
  await waitRolledOut();
  await waitHttp200();

  // 2. навантаження: власний тимчасовий файл, який потім зносимо
  const dir = mkdtempSync(join(tmpdir(), 'hw28-load-'));
  const codes = join(dir, 'codes.txt');
  const stop = join(dir, 'stop');
  const load = spawn('bash', [join(ROOT, 'scripts/load.sh'), SERVICE_URL, codes, stop, String(WORKERS)], { stdio: 'ignore' });
  const loadExited = new Promise((r) => load.on('exit', r));
  const lines = () => {
    try { const t = readFileSync(codes, 'utf8'); return t ? t.split('\n').length - 1 : 0; } catch { return 0; }
  };

  try {
    await sleep(4000); // даємо навантаженню вийти на режим

    // 3. нова ревізія -> змінюється pod-шаблон -> Deployment викочується
    //    (декларацією через Pulumi, а не kubectl: інакше самі відберемо поле)
    const t0 = Date.now();
    setConfig('rev', `${profile}-${stamp}-b`);
    pulumi('up');
    await waitRolledOut();
    const rolloutSeconds = (Date.now() - t0) / 1000;
    const loadStart = t0 - 4000;

    // 4. вимір не може бути порожнім: допоки не набралось MIN_REQUESTS
    while (true) {
      const elapsed = (Date.now() - loadStart) / 1000;
      if (elapsed >= MIN_LOAD_S && lines() >= MIN_REQUESTS) break;
      if (elapsed >= MAX_LOAD_S) break;
      await sleep(1000);
    }
    writeFileSync(stop, '');
    await loadExited;

    // 5. класифікація — З ФАЙЛА. Жодного echo з готовим висновком.
    const all = existsSync(codes) ? readFileSync(codes, 'utf8').split('\n').filter(Boolean) : [];
    const requests = all.length;
    const ok = all.filter((c) => c === '200').length;
    return { requests, ok, failed: requests - ok, rolloutSeconds };
  } finally {
    writeFileSync(stop, '');
    load.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(r, profileNum, prefix = '') {
  out(`${prefix}profile`, profileNum);
  out(`${prefix}requests`, r.requests);
  out(`${prefix}ok`, r.ok);
  out(`${prefix}failed`, r.failed);
  out(`${prefix}rollout-seconds`, r.rolloutSeconds.toFixed(1));
}

const compare = process.argv.includes('--compare');
let exitCode = 0;
try {
  if (compare) {
    log('→ профіль bad: без проб, без SIGTERM-обробника, maxUnavailable: 1');
    const bad = await runOnce('bad');
    report(bad, 0, 'bad-');
    out('bad-failed-pct', bad.requests ? ((bad.failed / bad.requests) * 100).toFixed(1) : 'nan');
  }
  log('→ профіль good: maxUnavailable 0, grace > дренаж, readiness ≠ liveness, SIGTERM-дренаж');
  const good = await runOnce('good');
  report(good, 1);
  if (good.failed !== 0 || good.requests < MIN_REQUESTS) {
    log(`✗ очікувалось failed=0 при requests>=${MIN_REQUESTS}`);
    exitCode = 1;
  }
} catch (e) {
  log(`✗ ${e.message}`);
  exitCode = 1;
  // навіть після збою лишаємо кластер у коректному профілі
  try { setConfig('profile', 'good'); pulumi('up'); } catch { /* не маскуємо першу помилку */ }
}
process.exit(exitCode);
