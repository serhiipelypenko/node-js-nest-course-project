// Спільні дрібниці демо hw-28 (rollout, pdb). stdout демо — лише key=число.
import { spawnSync } from 'node:child_process';

export const CTX = process.env.KUBE_CONTEXT ?? 'kind-hw28';
export const NS = process.env.NAMESPACE ?? 'marketplace';
export const APP = process.env.APP_NAME ?? 'marketplace-api';
export const SERVICE_URL = process.env.SERVICE_URL ?? 'http://127.0.0.1:22880/';

export const log = (...a) => console.error(...a);
export const out = (k, v) => console.log(`${k}=${v}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function kubectl(...args) {
  return sh('kubectl', ['--context', CTX, '-n', NS, ...args]);
}

// Чекає, поки Deployment повністю викотився: всі репліки оновлені й готові, старих нема.
export async function waitRolledOut(timeoutS = 300) {
  const r = kubectl('rollout', 'status', `deploy/${APP}`, `--timeout=${timeoutS}s`);
  if (r.code !== 0) throw new Error(`rollout status: ${(r.err || r.out).trim()}`);
}
