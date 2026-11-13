#!/usr/bin/env node
// hw-28 demo:image — чи образ production-grade і чи секрет збірки не осів в образі.
// Кожне число РАХУЄТЬСЯ з виміру (docker run, docker history, docker image inspect,
// розпакований docker save), а не друкується з голови. stdout — лише key=число.
//
// Токен — випадкова приманка, яка існує тільки в цьому процесі й у тимчасовій теці.
// Щоб довести, що детектори вміють ловити, збираємо ще два навмисно «брудних» образи
// (ARG і COPY+rm) і перевіряємо, що детектор їх бачить; інакше нуль нічого не означає.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'marketplace-api:demo-image';
const TAG_ARG = 'marketplace-api:demo-leak-arg';
const TAG_COPY = 'marketplace-api:demo-leak-copy';
const log = (...a) => console.error(...a);
const out = (k, v) => console.log(`${k}=${v}`);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const count = (hay, needle) => (hay.split(needle).length - 1);

const work = mkdtempSync(join(tmpdir(), 'hw28-image-'));
const token = `hw28-decoy-${randomBytes(18).toString('hex')}`;
const tokenFile = join(work, 'npm_token');
writeFileSync(tokenFile, token, { mode: 0o600 });

function cleanup() {
  rmSync(work, { recursive: true, force: true });
  sh('docker', ['rmi', '-f', TAG, TAG_ARG, TAG_COPY]);
}
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

// ── 1. збірка справжнього Dockerfile з випадковим токеном ────────────────────
log('→ збираю production-образ з токеном-приманкою (--no-cache: RUN із секретом має виконатись)');
const build = sh('docker', ['build', '--no-cache', '--secret', `id=npm_token,src=${tokenFile}`,
  '-f', join(ROOT, 'docker/Dockerfile'), '-t', TAG, join(ROOT, 'service')], { env: { ...process.env, DOCKER_BUILDKIT: '1' } });
if (build.code !== 0) { log(build.err.slice(-1500)); process.exit(1); }

// ── 2. stages: кількість FROM у Dockerfile ───────────────────────────────────
const df = readFileSync(join(ROOT, 'docker/Dockerfile'), 'utf8');
const stages = df.split('\n').filter((l) => /^\s*FROM\s/i.test(l)).length;
out('stages', stages);

// ── 3. shell-inside: ЗАПУСКОМ, а не читанням Dockerfile ──────────────────────
// База, успадкована від чужого образу, могла б принести shell без нашого відома.
let shellInside = 0;
for (const sp of ['sh', '/bin/sh', '/busybox/sh', 'bash', '/bin/bash']) {
  const r = sh('docker', ['run', '--rm', '--entrypoint', sp, TAG, '-c', 'exit 0']);
  if (r.code === 0) { shellInside = 1; log(`shell знайдено: ${sp}`); break; }
}
out('shell-inside', shellInside);

// ── 4. runtime-uid: те, чим процес працює насправді ──────────────────────────
const ep = JSON.parse(sh('docker', ['image', 'inspect', TAG, '--format', '{{json .Config.Entrypoint}}']).out || '[]');
const uidRun = sh('docker', ['run', '--rm', '--entrypoint', ep[0] ?? 'node', TAG, '-e', 'process.stdout.write(String(process.getuid()))']);
const uid = /^\d+$/.test(uidRun.out.trim()) ? uidRun.out.trim() : '';
if (!uid) log(`uid не отримано: ${uidRun.err.slice(0, 200)}`);
out('runtime-uid', uid);

// ── 5. три канали пошуку токена ──────────────────────────────────────────────
function history(tag) {
  return count(sh('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', tag]).out, token);
}
function config(tag) {
  return count(sh('docker', ['image', 'inspect', tag]).out, token);
}
// docker save -> розпакувати -> кожен blob, що є tar-шаром, розпакувати -> grep по байтах.
// rm наступним шаром лишає whiteout: у фінальній ФС файла нема, а байти — у старому шарі.
function layers(tag) {
  const dir = mkdtempSync(join(work, 'save-'));
  const tarFile = join(dir, 'image.tar');
  if (sh('docker', ['save', tag, '-o', tarFile]).code !== 0) return -1;
  const unpacked = join(dir, 'x');
  mkdirSync(unpacked);
  sh('tar', ['-xf', tarFile, '-C', unpacked]);
  const blobs = join(unpacked, 'blobs', 'sha256');
  let files;
  try { files = readdirSync(blobs); } catch { files = []; }
  let hits = 0;
  let n = 0;
  for (const f of files) {
    const dst = join(dir, `layer-${n++}`);
    mkdirSync(dst);
    // не-tar blob-и (json конфіги/маніфести) tar відкине — їх не рахуємо як шари
    if (sh('tar', ['-xf', join(blobs, f), '-C', dst]).code !== 0) continue;
    const g = sh('grep', ['-rlF', '--', token, dst]);
    hits += g.out.split('\n').filter(Boolean).length;
  }
  // старий формат docker save (layer.tar у теках)
  if (files.length === 0) {
    const g = sh('grep', ['-rlF', '--', token, unpacked]);
    hits += g.out.split('\n').filter(Boolean).length;
  }
  rmSync(dir, { recursive: true, force: true });
  return hits;
}

const hist = history(TAG), conf = config(TAG), lay = layers(TAG);
out('token-in-history', hist);
out('token-in-config', conf);
out('token-in-layers', lay);

// ── 6. самоперевірка детекторів на навмисно брудних образах ──────────────────
log('→ контроль: чи детектори взагалі вміють ловити витік');
const ctx = join(work, 'ctx');
mkdirSync(ctx);
copyFileSync(tokenFile, join(ctx, 'npm_token'));
const bArg = sh('docker', ['build', '-q', '--build-arg', `NPM_TOKEN=${token}`, '-f', join(ROOT, 'docker/selftest/arg.Dockerfile'), '-t', TAG_ARG, ctx]);
const bCopy = sh('docker', ['build', '-q', '-f', join(ROOT, 'docker/selftest/copy.Dockerfile'), '-t', TAG_COPY, ctx]);
const argHist = bArg.code === 0 ? history(TAG_ARG) : -1;
const copyLay = bCopy.code === 0 ? layers(TAG_COPY) : -1;
const copyHist = bCopy.code === 0 ? history(TAG_COPY) : -1;
out('selftest-arg-history', argHist);
out('selftest-copy-layers', copyLay);
out('selftest-copy-history', copyHist);
const detectorsWork = argHist > 0 && copyLay > 0 && copyHist === 0;
out('detectors-work', detectorsWork ? 1 : 0);

const size = Number(sh('docker', ['image', 'inspect', TAG, '--format', '{{.Size}}']).out.trim());
out('image-size-mb', Math.round(size / 1024 / 1024));

const ok = stages >= 2 && shellInside === 0 && uid !== '' && uid !== '0'
  && hist === 0 && conf === 0 && lay === 0 && detectorsWork;
process.exit(ok ? 0 : 1);
