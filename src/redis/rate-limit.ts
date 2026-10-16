import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';

// Rate-limit на спільному сховищі: лічильник у Redis, не в памʼяті процесу —
// N подів ділять ОДИН ліміт (лічильник у памʼяті пропустив би N × limit).
//
// Модель — ковзне вікно (ZSET часових міток). Чому: сплеск на межі вікна
// заборонений — фіксоване вікно пропускає до 2× ліміту навколо границі, а
// token bucket свідомо віддає залп; для публічного API, де «один клієнт не
// має зʼїсти сервіс», сплеск нам не потрібен.
//
// ZREMRANGEBYSCORE + ZCARD + ZADD — ОДИН Lua-скрипт: інакше між ZCARD і ZADD
// влізає інший под і ліміт протікає рівно під навантаженням. Тут атомарність —
// вимога КОРЕКТНОСТІ (на відміну від лока кеша, де вона лише оптимізація).
// Час береться з Redis (TIME), а не з годинників подів: розбіжність годинників
// між подами не ламає вікно.
const SLIDING_WINDOW_LUA = `
local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local win = tonumber(ARGV[1])
local lim = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)
local n = redis.call('ZCARD', KEYS[1])
if n < lim then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], win)
  return {1, lim - n - 1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + win - now}`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Через скільки секунд можна повторити (≥1, коли заборонено). */
  retryAfterSec: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  prefix?: string;
  /** Redis недоступний: true — пропускаємо (сервіс важливіший за ліміт), false — 503. */
  failOpen?: boolean;
}

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly opts: RateLimitOptions,
  ) {}

  async check(clientId: string): Promise<RateLimitResult> {
    try {
      const [allowed, remaining, retryMs] = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        `${this.opts.prefix ?? 'rl:'}${clientId}`,
        String(this.opts.windowMs),
        String(this.opts.limit),
        randomUUID(),
      )) as [number, number, number];
      return {
        allowed: allowed === 1,
        remaining,
        retryAfterSec: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
      };
    } catch (e) {
      console.error(`[ratelimit] ${(e as Error).message}`);
      if (this.opts.failOpen ?? true) {
        return { allowed: true, remaining: this.opts.limit, retryAfterSec: 0 };
      }
      throw e;
    }
  }
}

/** Connect-style middleware: 429 + Retry-After (problem+json, як решта API) при перевищенні. */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  clientOf: (req: IncomingMessage) => string,
) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const r = await limiter.check(clientOf(req));
      if (r.allowed) return next();
      res.statusCode = 429;
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.setHeader('Content-Type', 'application/problem+json');
      res.end(
        JSON.stringify({
          type: 'about:blank#rate-limited',
          title: 'Too Many Requests',
          status: 429,
          detail: `Ліміт вичерпано, повторіть через ${r.retryAfterSec} с`,
        }),
      );
    } catch (e) {
      next(e);
    }
  };
}
