#!/usr/bin/env node
// hw-32 demo:oidc — гейт із конвеєра (scripts/oidc-gate.mjs) на власноруч підписаних токенах.
// Без GitHub, без хмари, без мережі назовні: RSA-пара генерується в момент запуску, JWKS піднімає сам скрипт.
// Три обовʼязкові випадки + два додаткові; вивід — блоки case=…, sig-verified=…, policy-allow=… (1 1 · 1 0 · 0 0).
// Умова на sub береться з РЕАЛЬНОГО oidc/policy.json (лише iss/aud — локальні): демо перевіряє саме той рядок,
// що стоїть у конвеєрі. Токен ніде не друкується.
import crypto from 'node:crypto';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverJwksUri, gate, loadPolicy } from '../scripts/oidc-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const real = loadPolicy(join(ROOT, 'oidc/policy.json'));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = crypto.randomBytes(8).toString('hex');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

// локальний емітент: discovery-документ + JWKS на ефемерному порту
let ISS = '';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer: ISS, jwks_uri: `${ISS}/jwks` }));
  else res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
ISS = `http://127.0.0.1:${srv.address().port}`;

const policy = { ...real, iss: ISS, aud: 'marketplace-hw32-local' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (payload, key = privateKey) => {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
};
const now = Math.floor(Date.now() / 1000);
const base = { iss: ISS, aud: policy.aud, iat: now, exp: now + 300, jti: crypto.randomUUID() };

const green = sign({ ...base, sub: policy.sub[0] });
// коректний підпис і aud, але sub — ЧУЖИЙ репозиторій (той самий формат, інший власник)
const foreign = sign({ ...base, sub: 'repo:EVIL@1/attacker@2:environment:production' });
// той самий payload, що в green, але зіпсований підпис
const [h, p, s] = green.split('.');
const badSig = `${h}.${p}.${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
// додатково: без підпису (alg none) і чужий aud
const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`;
const wrongAud = sign({ ...base, aud: 'sts.amazonaws.com', sub: policy.sub[0] });

const cases = [
  ['green', green, [1, 1]],
  ['foreign-sub', foreign, [1, 0]],
  ['bad-signature', badSig, [0, 0]],
  ['unsigned', unsigned, [0, 0]],
  ['wrong-aud', wrongAud, [1, 0]],
];
let bad = 0;
for (const [name, token, [sigExp, polExp]] of cases) {
  const r = await gate(token, { policy, jwksUrl: `${ISS}/jwks` });
  console.log(`case=${name}`);
  console.log(`sig-verified=${r.sigVerified}`);
  console.log(`policy-allow=${r.policyAllow}`);
  console.log(`reason=${r.reason}`);
  if (r.sigVerified !== sigExp || r.policyAllow !== polExp) {
    bad++;
    console.error(`✗ ${name}: очікували ${sigExp} ${polExp}, отримали ${r.sigVerified} ${r.policyAllow}`);
  }
}

// discovery-шлях (той, що в конвеєрі, коли --jwks-url не задано): iss -> jwks_uri
const discovered = await discoverJwksUri(ISS);
const viaDiscovery = await gate(green, { policy });
console.log('case=discovery');
console.log(`discovered-jwks-uri-ok=${discovered === `${ISS}/jwks` ? 1 : 0}`);
console.log(`sig-verified=${viaDiscovery.sigVerified}`);
console.log(`policy-allow=${viaDiscovery.policyAllow}`);
if (discovered !== `${ISS}/jwks` || viaDiscovery.sigVerified !== 1 || viaDiscovery.policyAllow !== 1) bad++;

srv.close();
console.log(`oidc-cases-failed=${bad}`);
process.exit(bad === 0 ? 0 : 1);
