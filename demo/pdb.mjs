#!/usr/bin/env node
// hw-28 demo:pdb — PDB лишає місце для обслуговування і зупиняє ДРУГЕ виселення.
// Виселення йдуть через Eviction API (POST .../pods/<name>/eviction); число — це
// справжній HTTP-код відповіді: 201 (дозволено) і 429 (бюджет вичерпано).
// 🔴 Звичайне `kubectl delete pod` PDB НЕ зупиняє — бюджет діє лише на Eviction API.
// Демо витрачає бюджет, тож порядок: спершу disruptionsAllowed >= 1, потім демо.
import { spawn } from 'node:child_process';
import { CTX, NS, APP, kubectl, log, out, sh, sleep, waitRolledOut } from './lib.mjs';

function pdb() {
  const r = kubectl('get', 'pdb', APP, '-o', 'json');
  if (r.code !== 0) throw new Error(`немає PDB ${APP}: ${(r.err || r.out).trim()}`);
  const j = JSON.parse(r.out);
  return {
    minAvailable: j.spec.minAvailable,
    healthy: j.status.currentHealthy ?? 0,
    allowed: j.status.disruptionsAllowed ?? 0,
  };
}

function readyPods() {
  const j = JSON.parse(kubectl('get', 'pods', '-l', `app=${APP}`, '-o', 'json').out);
  return j.items
    .filter((p) => !p.metadata.deletionTimestamp && p.status?.phase === 'Running'
      && (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
    .map((p) => p.metadata.name);
}

async function waitFor(pred, what, timeoutS = 120) {
  for (let i = 0; i < timeoutS; i++) {
    if (pred()) return;
    await sleep(1000);
  }
  throw new Error(`не дочекались: ${what}`);
}

// kubectl proxy на вільному порту: далі звичайний curl і справжній код відповіді
function startProxy() {
  return new Promise((resolve, reject) => {
    const p = spawn('kubectl', ['--context', CTX, 'proxy', '--port=0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => {
      const m = /127\.0\.0\.1:(\d+)/.exec(String(d));
      if (m) resolve({ proc: p, port: m[1] });
    });
    p.on('exit', () => reject(new Error('kubectl proxy завершився')));
  });
}

function evict(port, pod) {
  const body = JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace: NS } });
  const r = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', body,
    `http://127.0.0.1:${port}/api/v1/namespaces/${NS}/pods/${pod}/eviction`]);
  return r.out.trim();
}

let proxy;
let exitCode = 0;
try {
  await waitRolledOut(120);
  await waitFor(() => pdb().allowed >= 1, 'disruptionsAllowed >= 1');
  const before = pdb();
  out('healthy', before.healthy);
  out('minAvailable', before.minAvailable);
  out('disruptions-allowed', before.allowed);

  const pods = readyPods();
  if (pods.length < 2) throw new Error(`потрібно щонайменше 2 готові поди, є ${pods.length}`);

  proxy = await startProxy();
  const e1 = evict(proxy.port, pods[0]);
  const e2 = evict(proxy.port, pods[1]); // одразу: бюджет вже витрачено
  out('evict-1', e1);
  out('evict-2', e2);
  if (e1 !== '201' || e2 !== '429') exitCode = 1;
} catch (e) {
  log(`✗ ${e.message}`);
  exitCode = 1;
} finally {
  proxy?.proc.kill('SIGTERM');
  // прибираємо за собою: чекаємо, поки заміна виселеного пода стане готовою
  try {
    await waitRolledOut(180);
    // виселені поди ще можуть догорати (Terminating), а заміна — прогріватись
    const desired = Number(kubectl('get', 'deploy', APP, '-o', 'jsonpath={.spec.replicas}').out);
    const total = () => JSON.parse(kubectl('get', 'pods', '-l', `app=${APP}`, '-o', 'json').out).items.length;
    await waitFor(() => readyPods().length >= desired && total() === desired, 'усі репліки готові, Terminating нема', 180);
    await waitFor(() => pdb().allowed >= 1, 'відновлення бюджету PDB', 180);
    log('✓ кластер повернуто в стан до демо');
  } catch (e) {
    log(`⚠ не дочекались відновлення: ${e.message}`);
  }
}
process.exit(exitCode);
