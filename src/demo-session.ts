// hw-23, demo:session — сесія в Redis із rolling TTL, переживає «рестарт» процесу.
//
// Реальний HTTP: node:http-сервер із sessionMiddleware, клієнт — fetch з cookie.
// «Рестарт» = закрити сервер і Redis-зʼєднання та підняти нові з нуля: памʼять
// процесу втрачена, сесія лишилась лише в Redis.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { queueRedisUrl } from './redis/config';
import { closeAll, connect } from './redis/clients';
import { sessionMiddleware, SessionStore, type WithSession } from './redis/session';
import { bool, expect, info, kv, run, sleep } from './redis/demo-lib';

const TTL_SEC = 20;

async function startServer(store: SessionStore): Promise<http.Server> {
  const mw = sessionMiddleware(store);
  const server = http.createServer((req: WithSession, res) => {
    mw(req, res, async (err) => {
      if (err || !req.session) {
        res.statusCode = 500;
        return res.end();
      }
      const visits = Number(req.session.data.visits ?? 0) + 1;
      await store.save(req.session.id, { ...req.session.data, visits });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sid: req.session.id, visits }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

run(async () => {
  // Сесії — на інстансі ЧЕРГИ (noeviction + AOF), не на кеші з allkeys-lru.
  let redis = connect(queueRedisUrl(), 'demo-session');
  let server = await startServer(new SessionStore(redis, TTL_SEC));
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const sids = new Set<string>();
  let cookie = '';
  let requests = 0;
  const hit = async (): Promise<{ sid: string; visits: number }> => {
    const res = await fetch(url(), { headers: cookie ? { cookie } : {} });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] as string;
    const body = (await res.json()) as { sid: string; visits: number };
    sids.add(body.sid);
    requests++;
    return body;
  };

  const first = await hit();
  const key = `sess:${first.sid}`;
  const ttlAfterCreate = await redis.pttl(key);

  await sleep(2000); // без паузи TTL не встигне зменшитись і rolling не відрізнити від його відсутності
  const ttlBefore = await redis.pttl(key);
  await hit(); // активність → GETEX продовжує TTL
  const ttlAfter = await redis.pttl(key);
  info(`pttl: створена=${ttlAfterCreate} перед=${ttlBefore} після=${ttlAfter}`);

  // «Рестарт процесу»: сервер, store і зʼєднання — нові; cookie клієнта та сама.
  await new Promise<void>((r) => server.close(() => r()));
  await closeAll(redis);
  redis = connect(queueRedisUrl(), 'demo-session-2');
  server = await startServer(new SessionStore(redis, TTL_SEC));
  const afterRestart = await hit();
  await hit();
  expect(afterRestart.visits === 3, `після рестарту visits=${afterRestart.visits}, очікувалось 3`);

  const inRedis = (await redis.exists(key)) === 1;
  kv('requests', requests);
  kv('sessions', sids.size);
  kv('in-redis', bool(inRedis));
  kv('ttl-renewed', bool(ttlAfter > ttlBefore));
  expect(sids.size === 1 && inRedis && ttlAfter > ttlBefore && requests >= 3, 'сесія');

  await redis.del(key);
  await new Promise<void>((r) => server.close(() => r()));
  await closeAll(redis);
});
