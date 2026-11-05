// hw-26: локальний «CDN» — кеш-шар перед ЗАКРИТИМ сховищем (форма OAC).
// До сховища ходить кеш своїми креденшелами (SDK), публіка — лише до кеша.
// Власний заголовок X-Cache: HIT|MISS (у CloudFront він теж є, інше значення).
import { createServer, type Server } from 'node:http';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { errName, errStatus } from '../storage/s3';
import { ASSET_PREFIX } from './assets';

interface Entry { body: Buffer; type: string; etag?: string; cc: string; expires: number }

// Кешуємо лише те, що origin дозволив: s-maxage/max-age > 0 і не private/no-store.
// Cache-Control немає -> TTL 0 -> кешувати нічого (cache-hit=0 — типова помилка).
function ttlSec(cc = ''): number {
  if (/\b(no-store|no-cache|private)\b/i.test(cc)) return 0;
  const m = /\bs-maxage=(\d+)/i.exec(cc) ?? /\bmax-age=(\d+)/i.exec(cc);
  return m ? Number(m[1]) : 0;
}

export function startEdge(s3: S3Client, bucket: string): Promise<{ server: Server; port: number; stats: { origin: number } }> {
  const cache = new Map<string, Entry>();
  const stats = { origin: 0 };
  const server = createServer((req, res) => {
    void (async () => {
      const key = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '');
      // edge віддає ЛИШЕ публічні ассети: приватні uploads/ через нього не прочитати
      if (req.method !== 'GET' || !key.startsWith(ASSET_PREFIX) || key.includes('..')) {
        res.writeHead(403).end();
        return;
      }
      let hit = cache.get(key);
      if (hit && hit.expires <= Date.now()) { cache.delete(key); hit = undefined; }
      const xcache = hit ? 'HIT' : 'MISS';
      if (!hit) {
        try {
          stats.origin++;
          const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          const body = Buffer.from(await o.Body!.transformToByteArray());
          const cc = o.CacheControl ?? '';
          hit = { body, type: o.ContentType ?? 'application/octet-stream', etag: o.ETag, cc, expires: Date.now() + ttlSec(cc) * 1000 };
          if (ttlSec(cc) > 0) cache.set(key, hit);
        } catch (e) {
          res.writeHead(errName(e) === 'NoSuchKey' || errStatus(e) === 404 ? 404 : 502).end();
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': hit.cc, ...(hit.etag ? { ETag: hit.etag } : {}), 'X-Cache': xcache });
      res.end(hit.body);
    })();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, stats })));
}
