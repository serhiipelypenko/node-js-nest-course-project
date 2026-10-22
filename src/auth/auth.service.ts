import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import type { Env } from '../config/env.schema';
import { PG_POOL } from '../database/database.module';
import { AuthUser, Role, TokenPair } from './auth.types';
import { verifyPassword } from './password';
import { TokenError, TokenService } from './token.service';

export function unauthorized(code: string, detail: string): UnauthorizedException {
  return new UnauthorizedException({ code, detail });
}

// Усі відмови refresh для клієнта однакові: інакше відповідь стала б оракулом
// («цей токен існував, але вже використаний»). Різницю бачить лише лог.
const BAD_REFRESH = () => unauthorized('invalid-refresh-token', 'refresh-токен недійсний');

const PURGE_EVERY_MS = 5 * 60_000;

interface RefreshRow {
  id: string;
  family_id: string;
  user_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Auth');
  private readonly pepper: string;
  private readonly refreshTtlSec: number;
  private purgeTimer?: NodeJS.Timeout;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tokens: TokenService,
    config: ConfigService<Env, true>,
  ) {
    this.pepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
    this.refreshTtlSec = config.get('REFRESH_TOKEN_TTL_SEC', { infer: true });
  }

  // Денилист «зникає сам»: запис потрібен рівно до exp токена, далі це сміття.
  // Postgres не має TTL на ключ, як Redis, тому чистимо таймером.
  onModuleInit(): void {
    this.purgeTimer = setInterval(() => {
      this.purgeDenylist().catch((e: Error) => this.logger.warn(`purge денилиста: ${e.message}`));
    }, PURGE_EVERY_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.purgeTimer);
  }

  // ── 1. Логін ───────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<TokenPair> {
    const { rows } = await this.pool.query<{ id: string; role: Role; password_hash: string | null }>(
      `SELECT id::text, role, password_hash FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok) throw unauthorized('invalid-credentials', 'невірний email або пароль');

    // Новий логін = нова сімʼя. Усі наступні refresh цієї сесії успадкують family_id.
    return this.issue(this.pool, user.id, user.role, randomUUID());
  }

  // ── 2. Ротація з детекцією повторного використання ──────────────────────
  // Одна транзакція: «погасити старий» + «видати новий» (або «відкликати сімʼю»)
  // — одним COMMIT. FOR UPDATE серіалізує два паралельних refresh одного
  // токена: другий побачить used_at і буде трактований як повтор.
  async refresh(rawToken: string): Promise<TokenPair> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const hash = this.hash(rawToken);
      const { rows } = await client.query<RefreshRow>(
        `SELECT id::text, family_id, user_id::text, used_at, revoked_at, expires_at
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hash],
      );
      const row = rows[0];

      if (!row) {
        await client.query('COMMIT');
        throw BAD_REFRESH();
      }
      if (row.revoked_at) {
        // Сімʼя вже мертва (логаут або попереднє виявлення повтору).
        await client.query('COMMIT');
        throw BAD_REFRESH();
      }
      if (row.used_at) {
        // 🔴 Токен, який уже обміняли, прийшов знову: або його вкрали, або клієнт
        // зламаний — відрізнити не можна, тож вбиваємо ВСЮ сімʼю. Чесний клієнт
        // теж вилетить (його поточний R2 — у тій самій сімʼї) і перелогіниться;
        // це ціна, за яку злодій не лишається в системі. COMMIT — обовʼязково,
        // інакше відкликання відкотилось би разом із відмовою.
        const { rowCount } = await client.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE family_id = $1 AND revoked_at IS NULL`,
          [row.family_id],
        );
        await client.query('COMMIT');
        this.logger.warn(
          `REFRESH REUSE: повторне використання refresh token_id=${row.id} ` +
            `family=${row.family_id} user=${row.user_id} — сімʼю відкликано (токенів: ${rowCount})`,
        );
        throw BAD_REFRESH();
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query('COMMIT');
        throw BAD_REFRESH();
      }

      // Роль перечитуємо з бази: refresh — природна точка, де «кеш у токені»
      // оновлюється (розжалуваний адмін перестає бути адміном тут).
      const user = await client.query<{ role: Role }>(`SELECT role FROM users WHERE id = $1`, [row.user_id]);
      if (!user.rows[0]) {
        await client.query('COMMIT');
        throw BAD_REFRESH();
      }

      await client.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      const pair = await this.issue(client, row.user_id, user.rows[0].role, row.family_id);
      await client.query('COMMIT');
      return pair;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined); // після COMMIT — no-op
      throw err;
    } finally {
      client.release();
    }
  }

  // ── 3. Логаут = ДВІ дії в одній транзакції ───────────────────────────────
  //  (а) revoked_at на сімʼю refresh — це рядки в БД, їх досить позначити;
  //  (б) jti access-токена в денилист із TTL = залишок життя — access
  //      self-contained, сервер його «не зберігає», тож без денилиста він
  //      жив би до exp.
  // Обидві дії в ОДНОМУ сховищі й одному COMMIT — жодного dual write.
  async logout(user: AuthUser): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
        [user.fid],
      );
      await client.query(
        `INSERT INTO access_denylist (jti, expires_at) VALUES ($1, to_timestamp($2))
           ON CONFLICT (jti) DO NOTHING`,
        [user.jti, user.exp],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    this.logger.log(`logout: family=${user.fid} jti=${user.jti} user=${user.id}`);
  }

  // ── Перевірка access-токена (використовує гард і WS-gateway) ────────────
  // exp перевіряє бібліотека, revoked — ми. Помилка БД тут НЕ глушиться:
  // якщо денилист недоступний, краще 500, ніж пропустити відкликаний токен.
  async authenticate(token: string): Promise<AuthUser> {
    let claims;
    try {
      claims = this.tokens.verify(token);
    } catch (err) {
      if (err instanceof TokenError) throw unauthorized(err.code, err.message);
      throw err;
    }
    const denied = await this.pool.query(`SELECT 1 FROM access_denylist WHERE jti = $1`, [claims.jti]);
    if (denied.rowCount) throw unauthorized('token-revoked', 'токен відкликано (логаут)');
    return { id: claims.sub, role: claims.role, jti: claims.jti, exp: claims.exp, fid: claims.fid };
  }

  async purgeDenylist(): Promise<number> {
    const r = await this.pool.query(`DELETE FROM access_denylist WHERE expires_at < now()`);
    return r.rowCount ?? 0;
  }

  // ── внутрішнє ───────────────────────────────────────────────────────────
  private hash(rawToken: string): string {
    // HMAC із перцем зі сховища: дамп refresh_tokens без перцю — не дамп сесій.
    return createHmac('sha256', this.pepper).update(rawToken).digest('hex');
  }

  private async issue(db: Pool | PoolClient, userId: string, role: Role, familyId: string): Promise<TokenPair> {
    const raw = randomBytes(32).toString('base64url'); // непрозорий, НЕ JWT
    await db.query(
      `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [this.hash(raw), familyId, userId, this.refreshTtlSec],
    );
    const access = this.tokens.sign(userId, role, familyId);
    return {
      access_token: access.token,
      refresh_token: raw,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTtlSec,
    };
  }
}
