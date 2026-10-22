import { createHash, createPrivateKey, createPublicKey, KeyObject, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { Env } from '../config/env.schema';
import { ROLES, Role } from './auth.types';

export const ISSUER = 'marketplace-api';
export const AUDIENCE = 'marketplace-clients';

// 🔴 Allowlist алгоритмів — єдиний надійний запобіжник від algorithm confusion
// (RFC 8725 §3.1): алгоритм вирішує ВЕРИФІКАТОР, а не поле alg із заголовка
// токена, яке контролює атакувальник. Один елемент — свідомо: ES256.
// Чому не RS256: OWASP JWT Cheat Sheet позначає RSASSA-PKCS1-v1_5 як
// «Not recommended»; ES256 коротший (підпис 64 байти проти 256) і швидший у підпису.
export const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ['ES256'];

export class TokenError extends Error {
  constructor(
    readonly code: 'token-expired' | 'invalid-token',
    message: string,
  ) {
    super(message);
  }
}

export interface VerifiedClaims {
  sub: string;
  role: Role;
  jti: string;
  exp: number;
  fid: string;
}

/** Відбиток публічного ключа: перші 8 hex sha256(SPKI DER). Ключ у лог не йде — лише відбиток. */
export function fingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 8);
}

const fromB64 = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

@Injectable()
export class TokenService {
  private readonly logger = new Logger('Auth');
  private readonly privateKey: KeyObject;
  private readonly kid: string;
  // kid -> публічний ключ. Поточний + (на час overlap-ротації) попередній.
  private readonly verifyKeys = new Map<string, KeyObject>();
  readonly accessTtlSec: number;

  constructor(config: ConfigService<Env, true>) {
    this.kid = config.get('JWT_KID', { infer: true });
    this.accessTtlSec = config.get('ACCESS_TOKEN_TTL_SEC', { infer: true });
    this.privateKey = createPrivateKey(fromB64(config.get('JWT_PRIVATE_KEY', { infer: true })));
    const publicKey = createPublicKey(fromB64(config.get('JWT_PUBLIC_KEY', { infer: true })));
    this.verifyKeys.set(this.kid, publicKey);

    const prevKid = config.get('JWT_PREVIOUS_KID', { infer: true });
    const prevPub = config.get('JWT_PREVIOUS_PUBLIC_KEY', { infer: true });
    if (prevKid && prevPub) this.verifyKeys.set(prevKid, createPublicKey(fromB64(prevPub)));

    // Пара має збігатись: інакше сервер видавав би токени, які сам же відкидає.
    // Краще впасти на старті, ніж на першому логіні.
    try {
      this.verify(this.sign('0', 'customer', randomUUID()).token);
    } catch {
      throw new Error('JWT_PUBLIC_KEY не відповідає JWT_PRIVATE_KEY (або JWT_KID) — пара ключів розсинхронізована');
    }

    for (const [kid, key] of this.verifyKeys) {
      this.logger.log(
        `ключ верифікації kid=${kid} fp=${fingerprint(key)} alg=${ALLOWED_ALGORITHMS.join(',')}` +
          (kid === this.kid ? ' (підпис)' : ' (лише перевірка, overlap)'),
      );
    }
  }

  sign(sub: string, role: Role, fid: string): { token: string; jti: string; exp: number } {
    const jti = randomUUID();
    const token = jwt.sign({ role, fid }, this.privateKey, {
      algorithm: 'ES256',
      keyid: this.kid, // за kid верифікатор вибирає ключ — основа overlap-ротації
      subject: sub,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.accessTtlSec,
      jwtid: jti,
    });
    const { exp } = jwt.decode(token) as { exp: number };
    return { token, jti, exp };
  }

  verify(token: string): VerifiedClaims {
    // decode — ЛИШЕ щоб прочитати kid і вибрати ключ. Довіри до нього нуль:
    // підпис, alg, iss, aud, exp перевіряє jwt.verify нижче.
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header.kid;
    const key = kid ? this.verifyKeys.get(kid) : undefined;
    if (!key) throw new TokenError('invalid-token', 'невідомий kid');

    let payload: jwt.JwtPayload;
    try {
      const result = jwt.verify(token, key, {
        algorithms: ALLOWED_ALGORITHMS,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof result === 'string') throw new TokenError('invalid-token', 'payload не обʼєкт');
      payload = result;
    } catch (err) {
      if (err instanceof TokenError) throw err;
      if (err instanceof jwt.TokenExpiredError) throw new TokenError('token-expired', 'токен протух');
      throw new TokenError('invalid-token', 'підпис або клейми не пройшли перевірку');
    }

    const { sub, role, jti, exp, fid } = payload as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number' ||
      typeof fid !== 'string' ||
      !ROLES.includes(role as Role)
    ) {
      throw new TokenError('invalid-token', 'відсутні обовʼязкові клейми');
    }
    return { sub, role: role as Role, jti, exp, fid };
  }
}
