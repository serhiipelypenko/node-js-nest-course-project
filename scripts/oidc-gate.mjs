#!/usr/bin/env node
// hw-32: гейт OIDC. ТОЙ САМИЙ код біжить у конвеєрі (джоба деплою) і в `npm run demo:oidc`.
//
// Дві незалежні відповіді, і обидві мають бути «так»:
//   sig-verified — підпис токена збігся з публічним ключем із JWKS (за kid), алгоритм — з allowlist;
//   policy-allow — iss, aud, sub (і строк дії) збігаються з умовою з файла oidc/policy.json.
// Без перевіреного підпису claims — просто текст: умову на них НЕ рахуємо (policy-allow = 0).
//
// Гейт не знає, що його запустили локально: iss, aud, адреса JWKS і файл умови — параметри.
//
// 🔴 Умова на `sub` — єдиний рядок, що відділяє твій репозиторій від чужого. Порівняння — ТОЧНЕ,
//    без шаблонів: «вужче» тут завжди краще, а `*` у файлі просто нічого не збігається.
//
// CLI (конвеєр):
//   node scripts/oidc-gate.mjs --policy oidc/policy.json            # токен — від GitHub (ACTIONS_ID_TOKEN_*)
//   OIDC_TOKEN=… node scripts/oidc-gate.mjs --policy … --jwks-url … # токен готовий (локально)
//   прапори: --iss --aud (перекривають файл), --jwks-url (без discovery), --github-output <файл>
// Токен НІКОЛИ не друкується (ні в stdout, ні в stderr): лише iss, aud, sub і два прапори.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ALLOWED_ALGS = ['RS256']; // allowlist, а не «те, що заявлено в заголовку»
const LEEWAY_S = 30;

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function loadPolicy(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof p.iss !== 'string' || typeof p.aud !== 'string' || !Array.isArray(p.sub) || p.sub.length === 0) {
    throw new Error(`${file}: потрібні iss (рядок), aud (рядок) і непорожній масив sub`);
  }
  return p;
}

/** discovery: iss -> /.well-known/openid-configuration -> jwks_uri. issuer у документі мусить збігатися з iss. */
export async function discoverJwksUri(iss) {
  const res = await fetch(`${iss.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery: HTTP ${res.status}`);
  const doc = await res.json();
  if (doc.issuer !== iss) throw new Error(`discovery: issuer у документі (${doc.issuer}) ≠ очікуваного (${iss})`);
  if (typeof doc.jwks_uri !== 'string') throw new Error('discovery: немає jwks_uri');
  return doc.jwks_uri;
}

export async function fetchJwks(jwksUrl) {
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`jwks: HTTP ${res.status}`);
  const jwks = await res.json();
  if (!Array.isArray(jwks.keys)) throw new Error('jwks: немає keys[]');
  return jwks;
}

/** Криптографія: чи підписав цей токен власник ключа з JWKS. Нічого не знає про sub/aud. */
export function verifySignature(token, jwks) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  if (!parts[2]) return { ok: false, reason: 'no-signature' };
  let header;
  let payload;
  try {
    header = b64json(parts[0]);
    payload = b64json(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!ALLOWED_ALGS.includes(header.alg)) return { ok: false, reason: `alg-${header.alg}` };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown-kid' };
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch {
    return { ok: false, reason: 'bad-key' };
  }
  return ok ? { ok: true, payload } : { ok: false, reason: 'bad-signature' };
}

/** Умова довіри: iss, aud, sub (точний збіг), строк дії. Викликається ЛИШЕ для claims із перевіреним підписом. */
export function evaluatePolicy(policy, claims, now = Math.floor(Date.now() / 1000)) {
  if (claims.iss !== policy.iss) return { allow: false, reason: 'iss-mismatch' };
  const aud = [].concat(claims.aud ?? []);
  if (!aud.includes(policy.aud)) return { allow: false, reason: 'aud-mismatch' };
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S <= now) return { allow: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) return { allow: false, reason: 'not-yet-valid' };
  if (typeof claims.sub !== 'string' || !policy.sub.includes(claims.sub)) return { allow: false, reason: 'sub-not-allowed' };
  return { allow: true, reason: 'ok' };
}

export async function gate(token, { policy, jwksUrl, now }) {
  const url = jwksUrl ?? (await discoverJwksUri(policy.iss));
  const jwks = await fetchJwks(url);
  const sig = verifySignature(token, jwks);
  if (!sig.ok) return { sigVerified: 0, policyAllow: 0, reason: sig.reason, claims: null };
  const pol = evaluatePolicy(policy, sig.payload, now);
  return { sigVerified: 1, policyAllow: pol.allow ? 1 : 0, reason: pol.reason, claims: sig.payload };
}

/** Токен від GitHub: запит на ACTIONS_ID_TOKEN_REQUEST_URL з потрібною audience. Потрібен id-token: write на джобі. */
export async function requestGithubToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new Error('немає ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN: на джобі забули permissions: id-token: write (дефолт його не містить)');
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`видача токена: HTTP ${res.status}`);
  const { value } = await res.json();
  if (typeof value !== 'string' || !value) throw new Error('видача токена: порожня відповідь');
  return value;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`невідомий аргумент ${argv[i]}`);
    o[argv[i].slice(2)] = argv[++i];
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(args.policy ?? 'oidc/policy.json');
  if (args.iss) policy.iss = args.iss;
  if (args.aud) policy.aud = args.aud;

  const token = process.env.OIDC_TOKEN || (await requestGithubToken(policy.aud));
  // Маска — страховка, а не захист: токен все одно ніде не друкується (README, «межа маскування»).
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);

  const r = await gate(token, { policy, jwksUrl: args['jwks-url'] });
  const claims = r.claims ?? {};
  const lines = {
    'oidc-iss': claims.iss ?? '',
    'oidc-aud': [].concat(claims.aud ?? []).join(','),
    'oidc-sub': claims.sub ?? '',
    'oidc-sig-verified': r.sigVerified,
    'oidc-policy-allow': r.policyAllow,
    'oidc-reason': r.reason,
  };
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  if (args['github-output']) {
    fs.appendFileSync(args['github-output'], Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  if (!(r.sigVerified === 1 && r.policyAllow === 1)) {
    console.error(`✗ OIDC-гейт відмовив: ${r.reason}. Дозволені sub — у ${args.policy ?? 'oidc/policy.json'}; фактичний sub — у рядку oidc-sub вище.`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
