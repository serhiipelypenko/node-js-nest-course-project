// Спільна обв'язка трьох демо hw-24 (demo:auth / demo:reuse / demo:rbac).
// Контракт кожного демо (task.md, п.7): (1) САМЕ піднімає застосунок і приводить
// стан до чистого, (2) друкує рядки `ключ=число` (число — HTTP-статус, тож вивід
// детермінований), (3) сама перевіряє інваріант і завершується з кодом ≠ 0, якщо
// його порушено.
//
// Застосунок піднімається В ЦЬОМУ Ж ПРОЦЕСІ (createApp + listen(0)): окремого
// дочірнього процесу, який міг би пережити батька й дати EADDRINUSE на другому
// прогоні, просто немає — порт ефемерний, закриття — app.close() у finally.
import 'reflect-metadata';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { Role } from './auth.types';
import { hashPassword } from './password';

export const PASSWORD = 'demo-password-1';

// Змінні, які демо МАЮТЬ отримати ззовні (сховище через with-secrets.sh або
// SKIP_VAULT=1). Дефолтів немає навмисно — той самий принцип, що в env.schema.ts.
const REQUIRED_ENV = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_KID',
  'REFRESH_TOKEN_PEPPER',
];

export interface Res {
  status: number;
  body: any;
}

export interface Demo {
  pool: Pool;
  /** POST/GET/... до піднятого застосунку. */
  call(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<Res>;
  /** Гарантує користувача з відомим паролем і роллю; повертає його id. */
  user(email: string, role: Role): Promise<string>;
  login(email: string): Promise<{ access_token: string; refresh_token: string }>;
  /** Друкує `key=status` і запамʼятовує розбіжність з очікуваним. */
  expect(key: string, actual: number, allowed: number[]): void;
  /** Додатковий інваріант поза HTTP-статусами (стан БД). */
  invariant(name: string, ok: boolean): void;
  close(): Promise<void>;
  exitCode(): number;
}

export async function startDemo(
  label: string,
  prepare?: (pool: Pool) => Promise<void>,
): Promise<Demo> {
  const missing = REQUIRED_ENV.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      `${label}: не задано ${missing.join(', ')}. Запускай через ` +
        `\`bash scripts/with-secrets.sh dev …\` або з SKIP_VAULT=1 і своїми значеннями.`,
    );
  }
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env as Record<string, string>;
  const DB_PORT = process.env.DB_PORT ?? '5432';

  // ── стан до чистого ──────────────────────────────────────────────────
  // Схему доводимо тими самими міграціями (ідемпотентно: вже накочені пропускаються).
  const { default: AppDataSource } = await import('../data-source');
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await AppDataSource.destroy();

  const pool = new Pool({ host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  pool.on('error', () => undefined);
  await pool.query('TRUNCATE refresh_tokens, access_denylist');
  if (prepare) await prepare(pool);

  // ── застосунок: той самий main.ts, що й у проді ─────────────────────────
  // HTTP-сервер читає DSN без пароля + файл із паролем (шлях A у CLAUDE.md);
  // зі змінних шляху B (DB_*) збираємо саме це. ПІСЛЯ присвоєння — бо
  // ConfigModule.forRoot({ validate }) валідує process.env у момент require.
  const dir = await mkdtemp(join(tmpdir(), 'hw24-demo-'));
  const passwordFile = join(dir, 'db_password');
  await writeFile(passwordFile, DB_PASSWORD, { mode: 0o600 });
  process.env.DB_URL = `postgres://${encodeURIComponent(DB_USER)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  process.env.DB_PASSWORD_FILE = passwordFile;

  const { createApp } = await import('../main');
  const app: INestApplication = await createApp(['error', 'warn']);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  let failed = false;
  const passwordHash = await hashPassword(PASSWORD);

  const call: Demo['call'] = async (method, path, opts = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* не JSON — лишаємо текстом */
    }
    return { status: res.status, body };
  };

  return {
    pool,
    call,
    async user(email, role) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, $1, $2, $3)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
         RETURNING id::text`,
        [email, passwordHash, role],
      );
      return rows[0].id;
    },
    async login(email) {
      const r = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login(${email}) -> ${r.status}`);
      return r.body;
    },
    expect(key, actual, allowed) {
      console.log(`${key}=${actual}`);
      if (!allowed.includes(actual)) {
        failed = true;
        console.error(`✗ ${key}: отримано ${actual}, очікувалось ${allowed.join(' або ')}`);
      }
    },
    invariant(name, ok) {
      if (!ok) {
        failed = true;
        console.error(`✗ інваріант порушено: ${name}`);
      }
    },
    async close() {
      await app.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
    exitCode: () => (failed ? 1 : 0),
  };
}

/** Запуск демо з гарантованим прибиранням і ненульовим кодом на будь-яку помилку. */
export async function runDemo(label: string, body: (d: Demo) => Promise<void>, prepare?: (pool: Pool) => Promise<void>): Promise<void> {
  let demo: Demo | undefined;
  try {
    demo = await startDemo(label, prepare);
    await body(demo);
    process.exitCode = demo.exitCode();
  } catch (err) {
    console.error(`✗ ${label}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await demo?.close();
  }
}
