// Спільна обв'язка демо hw-26. Контракт (task.md, п.6): (1) САМЕ приводить
// стан до чистого, (2) друкує у stdout ЛИШЕ рядки `ключ=число`, (3) сама
// перевіряє інваріант і завершується з кодом ≠ 0, якщо його порушено.
// Діагностика йде у stderr — stdout читає грейдер.
import 'reflect-metadata';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { hashPassword } from '../auth/password';
import type { Role } from '../auth/auth.types';
import { makeS3, storageFromEnv, type StorageConfig } from '../storage/s3';

export const PASSWORD = 'demo-password-1';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = false;
/** Друкує `key=value` і запамʼятовує розбіжність з очікуваним. */
export function expect(key: string, actual: number, allowed: number[]): void {
  console.log(`${key}=${actual}`);
  if (!allowed.includes(actual)) {
    failed = true;
    console.error(`✗ ${key}: отримано ${actual}, очікувалось ${allowed.join(' або ')}`);
  }
}
export function invariant(name: string, ok: boolean): void {
  if (!ok) { failed = true; console.error(`✗ інваріант порушено: ${name}`); }
}
export const bool = (b: boolean): number => (b ? 1 : 0);

/** Живість порту — сирим сокетом, не fetch (fetch тримає пул зʼєднань на (host, port)). */
export function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** Бакет існує (створюємо в емуляторі) + lifecycle: недороблений multipart прибирається за 7 діб. */
export async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await s3
    .send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [{ ID: 'abort-incomplete-mpu', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }],
      },
    }))
    .catch((e) => console.error(`(lifecycle не застосовано: ${e?.name}; див. README)`));
}

/** Чистий аркуш: усі обʼєкти під префіксом + ВСІ незавершені multipart (вони тарифікуються, хоч обʼєкта нема). */
export async function wipe(s3: S3Client, bucket: string, prefixes: string[]): Promise<void> {
  for (const prefix of prefixes) {
    for (;;) {
      const l = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      if (!l.Contents?.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: l.Contents.map((o) => ({ Key: o.Key })) } }));
    }
  }
  const m = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
  for (const u of m.Uploads ?? []) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }));
  }
}

export interface Res { status: number; body: any; headers: Headers }

export interface Harness {
  cfg: StorageConfig;
  s3: S3Client;
  pool: Pool;
  /** Піднімає застосунок на НОВОМУ ефемерному порту (старий порт повторно не беремо). */
  startApi(): Promise<{ app: INestApplication; port: number; base: string }>;
  stopApi(): Promise<void>;
  user(email: string, role: Role): Promise<string>;
  login(base: string, email: string): Promise<string>;
  call(base: string, method: string, path: string, o?: { token?: string; body?: unknown; headers?: Record<string, string>; manual?: boolean }): Promise<Res>;
  close(): Promise<void>;
}

const REQUIRED_DB = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KID', 'REFRESH_TOKEN_PEPPER'];

export async function boot(label: string, opts: { api: boolean } = { api: true }): Promise<Harness> {
  const cfg = storageFromEnv(); // кидає з іменами відсутніх змінних
  const s3 = makeS3(cfg);
  await ensureBucket(s3, cfg.bucket);

  const noop = { cfg, s3 } as Harness;
  if (!opts.api) return { ...noop, close: async () => s3.destroy() } as Harness;

  const missing = REQUIRED_DB.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`${label}: не задано ${missing.join(', ')}. Запускай через \`bash scripts/with-secrets.sh dev …\` або SKIP_VAULT=1.`);
  }
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env as Record<string, string>;
  const DB_PORT = process.env.DB_PORT ?? '5432';

  // схема — тими самими міграціями (ідемпотентно)
  const { default: AppDataSource } = await import('../data-source');
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await AppDataSource.destroy();

  const pool = new Pool({ host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  pool.on('error', () => undefined);
  await pool.query('TRUNCATE files');

  // шлях A сервера: DSN без пароля + файл із паролем
  const dir = await mkdtemp(join(tmpdir(), 'hw26-demo-'));
  const passwordFile = join(dir, 'db_password');
  await writeFile(passwordFile, DB_PASSWORD, { mode: 0o600 });
  process.env.DB_URL = `postgres://${encodeURIComponent(DB_USER)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  process.env.DB_PASSWORD_FILE = passwordFile;

  const passwordHash = await hashPassword(PASSWORD);
  let current: INestApplication | undefined;

  const call: Harness['call'] = async (base, method, path, o = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: o.manual ? 'manual' : 'follow',
      headers: {
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...o.headers,
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
    return { status: res.status, body, headers: res.headers };
  };

  return {
    cfg, s3, pool, call,
    async startApi() {
      const { createApp } = await import('../main');
      const app = await createApp(['error', 'warn']);
      await app.listen(0, '127.0.0.1');
      current = app;
      const { port } = app.getHttpServer().address() as { port: number };
      return { app, port, base: `http://127.0.0.1:${port}` };
    },
    async stopApi() {
      await current?.close().catch(() => undefined);
      current = undefined;
    },
    async user(email, role) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, $1, $2, $3)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
         RETURNING id::text`,
        [email, passwordHash, role],
      );
      return rows[0].id;
    },
    async login(base, email) {
      const r = await call(base, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login(${email}) -> ${r.status}`);
      return r.body.access_token;
    },
    async close() {
      await current?.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      s3.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Запуск з гарантованим прибиранням і ненульовим кодом на будь-яку помилку. */
export async function run(label: string, api: boolean, body: (h: Harness) => Promise<void>): Promise<void> {
  let h: Harness | undefined;
  try {
    h = await boot(label, { api });
    await body(h);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error(`✗ ${label}: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await h?.close();
  }
}
