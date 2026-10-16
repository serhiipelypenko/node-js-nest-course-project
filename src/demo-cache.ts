// hw-23, demo:cache — cache-aside з джитером + single-flight проти stampede.
//
// Сценарій: прогріти 60 карток → виміряти розкид TTL → ВИТІСНИТИ картку по-
// справжньому (заливка холодних даних під allkeys-lru, не DEL) → 50 одночасних
// читань: наївно (N походів у базу) і з локом (1) → 100 читань теплого кеша (0).
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { CacheAside } from './redis/cache';
import { cacheRedisUrl } from './redis/config';
import { closeAll, configGet, connect } from './redis/clients';
import { loadProductCard, type ProductCard } from './redis/product-card';
import { bool, countingDataSource, expect, info, kv, run } from './redis/demo-lib';

const WARM = 60;
const CONCURRENT = 50;
const COLD_VALUE = 'x'.repeat(1024);
const cardKey = (id: string): string => `card:${id}`;

async function seedProducts(ds: DataSource): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < WARM; i++) {
    const [p]: Array<{ id: string }> = await ds.query(
      `INSERT INTO products (sku, name, price, stock) VALUES ($1, $2, 10 + $3, 100)
       ON CONFLICT (sku) DO UPDATE SET stock = 100 RETURNING id`,
      [`CACHE-DEMO-${i}`, `Кеш-демо ${i}`, i],
    );
    ids.push(p.id);
  }
  await ds.query(`DELETE FROM reviews WHERE product_id = ANY($1::bigint[])`, [ids]);
  await ds.query(
    `INSERT INTO reviews (product_id, rating)
     SELECT p, 1 + (g % 5) FROM unnest($1::bigint[]) AS p, generate_series(1, 20) AS g`,
    [ids],
  );
  return ids;
}

/** Кожна заливка — у СВОЄМУ просторі імен: перезапис тих самих ключів памʼяті не додає, витіснення б не сталось. */
async function evictOne(r: Redis, candidates: string[]): Promise<string> {
  const ns = `cold:${randomUUID()}`;
  for (let batch = 0; batch < 200; batch++) {
    const p = r.pipeline();
    for (let k = 0; k < 1000; k++) p.set(`${ns}:${batch}:${k}`, COLD_VALUE);
    await p.exec();
    const e = r.pipeline();
    for (const id of candidates) e.exists(cardKey(id));
    const res = (await e.exec()) ?? [];
    const gone = candidates.find((_, i) => res[i]?.[1] === 0);
    // Кого забрав LRU — вирішує його вибірка (maxmemory-samples), а не ми.
    if (gone !== undefined) return gone;
  }
  throw new Error('жодна картка не витіснилась: перевір maxmemory/maxmemory-policy кеш-інстансу');
}

async function purge(r: Redis, pattern: string): Promise<void> {
  for await (const keys of r.scanStream({ match: pattern, count: 1000 })) {
    if ((keys as string[]).length) await r.unlink(...(keys as string[]));
  }
}

run(async () => {
  const redis = connect(cacheRedisUrl(), 'demo-cache');
  const { ds, logger } = countingDataSource();
  await ds.initialize();
  await ds.runMigrations(); // ідемпотентно: на свіжому клоні потрібна reviews

  const policy = await configGet(redis, 'maxmemory-policy');
  const maxmemory = Number(await configGet(redis, 'maxmemory'));
  kv('cache-lru', bool(policy !== 'noeviction'));
  kv('cache-maxmemory', bool(maxmemory > 0));
  info(`maxmemory-policy=${policy} maxmemory=${maxmemory}`);

  await purge(redis, 'card:*');
  await purge(redis, 'lock:card:*');
  await purge(redis, 'cold:*');

  const ids = await seedProducts(ds);
  const load = (key: string) => loadProductCard(ds, key.slice('card:'.length));
  const naive = new CacheAside<ProductCard>(redis, load, { singleFlight: false });
  const locked = new CacheAside<ProductCard>(redis, load);

  // 1. Прогрів + джитер TTL
  await Promise.all(ids.map((id) => locked.get(cardKey(id))));
  const ttls = await Promise.all(ids.map((id) => redis.ttl(cardKey(id))));
  const warmed = ttls.filter((t) => t > 0).length;
  kv('warmed', warmed);
  kv('ttl-distinct', new Set(ttls).size);
  expect(warmed >= 50, 'warmed < 50');

  // 2. Наївний cache-aside: ключ витіснено → усі 50 ідуть у базу
  const victimA = await evictOne(redis, ids);
  logger.reset();
  const tNaive = Date.now();
  await Promise.all(Array.from({ length: CONCURRENT }, () => naive.get(cardKey(victimA))));
  kv('db-calls-naive', logger.count);
  kv('wave-naive-ms', Date.now() - tNaive);

  // 3. Single-flight: інша витіснена картка → рівно 1 похід
  const victimB = await evictOne(
    redis,
    ids.filter((id) => id !== victimA),
  );
  logger.reset();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENT }, () => locked.get(cardKey(victimB))));
  kv('concurrent', CONCURRENT);
  kv('db-calls', logger.count);
  kv('wave-ms', Date.now() - t0);
  expect(logger.count === 1, `db-calls=${logger.count}, очікувалось 1`);

  // 4. Теплий кеш: 100 читань → 0 походів
  logger.reset();
  for (let i = 0; i < 100; i++) await locked.get(cardKey(victimB));
  kv('db-calls-warm', logger.count);
  expect(logger.count === 0, `db-calls-warm=${logger.count}, очікувалось 0`);

  await purge(redis, 'cold:*');
  await purge(redis, 'card:*');
  await ds.destroy();
  await closeAll(redis);
});
