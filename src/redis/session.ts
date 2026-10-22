import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';

// Сесії у Redis із rolling TTL. Стан — у Redis, не в памʼяті процесу: рестарт
// застосунку сесію не вбиває.
//
// Де живуть: на інстансі ЧЕРГИ (noeviction + AOF), НЕ на кеш-інстансі. Під
// allkeys-lru Redis колись викине живу сесію — розлогінення, яке неможливо
// відтворити. Третій інстанс був би ще чистіший, але для задачі зайвий; ціна
// рішення — сесії ділять maxmemory з чергою (див. README).

export interface SessionData {
  [k: string]: unknown;
}

export const SESSION_COOKIE = 'sid';

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec: number,
    private readonly prefix = 'sess:',
  ) {}

  key(sid: string): string {
    return this.prefix + sid;
  }

  async create(data: SessionData = {}): Promise<string> {
    const sid = randomBytes(24).toString('base64url');
    await this.redis.set(this.key(sid), JSON.stringify(data), 'EX', this.ttlSec);
    return sid;
  }

  /** Читання = продовження: GETEX віддає значення й одразу ставить TTL заново. Активного користувача не викине. */
  async touch(sid: string): Promise<SessionData | null> {
    const raw = await this.redis.getex(this.key(sid), 'EX', this.ttlSec);
    return raw === null ? null : (JSON.parse(raw) as SessionData);
  }

  async save(sid: string, data: SessionData): Promise<void> {
    await this.redis.set(this.key(sid), JSON.stringify(data), 'EX', this.ttlSec);
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(this.key(sid));
  }
}

export interface RequestSession {
  id: string;
  data: SessionData;
  isNew: boolean;
}

export type WithSession = IncomingMessage & { session?: RequestSession };

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Connect-style middleware (Express і голий node:http): знаходить сесію за
 * cookie й продовжує її TTL; немає/протухла — заводить нову. Кожен запит
 * проходить через touch(), тому TTL «ковзає» разом з активністю.
 */
export function sessionMiddleware(store: SessionStore) {
  return async (req: WithSession, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      const existing = sid ? await store.touch(sid) : null;
      if (sid && existing) {
        req.session = { id: sid, data: existing, isNew: false };
      } else {
        const id = await store.create();
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax`);
        req.session = { id, data: {}, isNew: true };
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
