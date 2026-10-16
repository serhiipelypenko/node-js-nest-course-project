// hw-23, demo:ratelimit — один ліміт на два «поди».
//
// Два незалежні екземпляри лімітера (кожен зі СВОЇМ Redis-зʼєднанням і СВОЇМ
// HTTP-сервером) обслуговують одного клієнта. Лічильник у памʼяті процесу
// пропустив би 2 × limit; спільний у Redis — рівно limit.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cacheRedisUrl } from './redis/config';
import { closeAll, connect } from './redis/clients';
import { RateLimiter, rateLimitMiddleware } from './redis/rate-limit';
import { bool, expect, kv, run } from './redis/demo-lib';

const LIMIT = 5;
const WINDOW_MS = 10_000;
const TOTAL = 14;
const CLIENT = `demo-${Date.now()}`;

run(async () => {
  const pods = await Promise.all(
    [1, 2].map(async (n) => {
      const redis = connect(cacheRedisUrl(), `demo-pod-${n}`);
      const mw = rateLimitMiddleware(new RateLimiter(redis, { limit: LIMIT, windowMs: WINDOW_MS }), (req) =>
        String(req.headers['x-api-key']),
      );
      const server = http.createServer((req, res) =>
        mw(req, res, () => {
          res.end('ok');
        }),
      );
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return { redis, server, port: (server.address() as AddressInfo).port };
    }),
  );

  let allowed = 0;
  let blocked = 0;
  let lastBlocked: Response | undefined;
  // Запити чергуються між подами: 1,2,1,2,… — кожен под бачить лише половину.
  for (let i = 0; i < TOTAL; i++) {
    const pod = pods[i % pods.length]!;
    const res = await fetch(`http://127.0.0.1:${pod.port}/`, { headers: { 'x-api-key': CLIENT } });
    await res.arrayBuffer();
    if (res.status === 429) {
      blocked++;
      lastBlocked = res;
    } else allowed++;
  }

  kv('instances', pods.length);
  kv('limit', LIMIT);
  kv('requests', TOTAL);
  kv('allowed', allowed);
  kv('blocked', blocked);
  kv('status', lastBlocked?.status ?? 0);
  kv('retry-after', bool(lastBlocked?.headers.has('retry-after') ?? false));
  expect(allowed === LIMIT && blocked === TOTAL - LIMIT, `allowed=${allowed} blocked=${blocked}`);

  await pods[0]!.redis.del(`rl:${CLIENT}`);
  for (const p of pods) await new Promise<void>((r) => p.server.close(() => r()));
  await closeAll(...pods.map((p) => p.redis));
});
