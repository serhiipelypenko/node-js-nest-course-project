#!/usr/bin/env node
// hw-32: збирає артефакт pipeline-evidence (його читає грейдер). Усі числа беруться з файлів, які створили джоби
// ЦЬОГО прогону (частини evidence-part-*), а не друкуються «готовими».
//
// Вхід (env): RUN_ID, HEAD_SHA, IMAGE_REF, BUILT_DIGEST, SCAN_EXIT, DEPLOY_ENV, PARTS_DIR (де розпаковані частини), OUT_DIR
// Вихід: OUT_DIR/{evidence.txt, deployment.json, plan.json, rollout.txt, build.log}
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const e = process.env;
const parts = e.PARTS_DIR ?? 'parts';
const out = e.OUT_DIR ?? 'pipeline-evidence';
const deployEnv = e.DEPLOY_ENV ?? 'preview';
mkdirSync(out, { recursive: true });

const part = (name, file) => join(parts, `evidence-part-${name}`, file);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const kv = (text) => Object.fromEntries(text.split('\n').filter((l) => /^[a-z0-9-]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const copy = (from, to) => (existsSync(from) ? (copyFileSync(from, join(out, to)), true) : (writeFileSync(join(out, to), ''), false));

copy(part('build', 'build.log'), 'build.log');
copy(part('plan', 'plan.json'), 'plan.json');
copy(part(deployEnv, 'deployment.json'), 'deployment.json');
copy(part(deployEnv, 'rollout.txt'), 'rollout.txt');

const buildLog = read(join(out, 'build.log'));
const buildInvocations = buildLog.split('\n').filter(Boolean).length;
const deploy = kv(read(part(deployEnv, 'deploy.txt')));
// oidc-* — з out/oidc.txt (пишеться ДО pulumi up), щоб червоний deploy не губив доказ підпису
const oidc = kv(read(part(deployEnv, 'oidc.txt')));
const cost = kv(read(part('plan', 'cost.txt')));
const rollout = kv(read(join(out, 'rollout.txt')));

// deployed-digest — з маніфеста, який поїхав у кластер (kubectl get deploy -o json)
let deployedDigest = '';
try {
  const image = JSON.parse(read(join(out, 'deployment.json'))).spec.template.spec.containers[0].image;
  deployedDigest = image.includes('@') ? image.slice(image.indexOf('@') + 1) : '';
} catch {
  /* порожній deployment.json на червоному прогоні — лишаємо порожнім */
}

const lines = {
  'run-id': e.RUN_ID ?? '',
  'head-sha': e.HEAD_SHA ?? '',
  'image-ref': e.IMAGE_REF ?? '',
  'built-digest': e.BUILT_DIGEST ?? '',
  'deployed-digest': deployedDigest,
  'build-invocations': buildInvocations,
  'creds-source': oidc['oidc-sig-verified'] === '1' ? 'oidc' : 'none',
  'oidc-iss': oidc['oidc-iss'] ?? '',
  'oidc-aud': oidc['oidc-aud'] ?? '',
  'oidc-sub': oidc['oidc-sub'] ?? '',
  'oidc-sig-verified': oidc['oidc-sig-verified'] ?? 0,
  'rollout-requests': rollout.requests ?? '',
  'rollout-ok': rollout.ok ?? '',
  'rollout-failed': rollout.failed ?? '',
  'rollout-seconds': rollout['rollout-seconds'] ?? '',
  'secret-in-manifest': deploy['secret-in-manifest'] ?? '',
  'gate-scan-exit': e.SCAN_EXIT ?? '',
  // додатково (зайві рядки дозволені)
  'running-digest': deploy['running-digest'] ?? '',
  'plan-usd': cost['plan-usd'] ?? '',
  'delta-usd': cost['delta-usd'] ?? '',
  'cost-gate': cost.gate ?? '',
  'deploy-environment': deployEnv,
};
writeFileSync(join(out, 'evidence.txt'), `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
console.log(readFileSync(join(out, 'evidence.txt'), 'utf8'));
