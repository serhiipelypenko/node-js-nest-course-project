#!/usr/bin/env node
// Друкує kid і ВІДБИТОК публічного ключа підпису (перші 8 hex від sha256 SPKI DER).
// Ключ у вивід не йде — лише відбиток (прийом hw-11). Призначення — довести, що
// dev і prod у сховищі підписують РІЗНИМИ ключами:
//
//   bash scripts/with-secrets.sh dev  node scripts/jwt-fingerprint.mjs
//   bash scripts/with-secrets.sh prod node scripts/jwt-fingerprint.mjs
import { createHash, createPublicKey } from 'node:crypto';

const need = (n) => {
  if (!process.env[n]) {
    console.error(`не задано ${n} (запускай через scripts/with-secrets.sh)`);
    process.exit(1);
  }
  return process.env[n];
};

const kid = need('JWT_KID');
const pem = Buffer.from(need('JWT_PUBLIC_KEY'), 'base64').toString('utf8');
const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
console.log(`kid=${kid} fp=${createHash('sha256').update(der).digest('hex').slice(0, 8)}`);
