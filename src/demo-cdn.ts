// demo:cdn — сховище закрите; публіка ходить тільки в кеш; оновлення без інвалідації.
//
//   direct=403        анонімний GET прямо у сховище (повз кеш)
//   edge-miss=200     перший запит через кеш: X-Cache MISS, edge сам сходив у сховище
//   edge-hit=200      другий: із кеша
//   cache-hit=1       другий відповів X-Cache: HIT
//   new-name=1        «деплой» з іншим вмістом дістав ІНШЕ імʼя (хеш вмісту)
//   new-url=200       нове імʼя віддається через кеш
//   content-changed=1 тіло за новим URL — нове
//   invalidations=0   жодної інвалідації за весь сценарій
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { publishAsset, IMMUTABLE } from './cdn/assets';
import { startEdge } from './cdn/edge';
import { bool, expect, invariant, run, wipe } from './files/demo-lib';

void run('demo:cdn', false, async (h) => {
  await wipe(h.s3, h.cfg.bucket, ['assets/']);

  // у публічній частині шляху — лише edge; сам edge ходить у приватний бакет з креденшелами
  const edge = await startEdge(h.s3, h.cfg.bucket);
  const via = (key: string) => fetch(`http://127.0.0.1:${edge.port}/${key}`);
  try {
    const v1 = await publishAsset(h.s3, h.cfg.bucket, 'app.css', 'body{color:#111}/* v1 */', 'text/css');
    const head = await h.s3.send(new HeadObjectCommand({ Bucket: h.cfg.bucket, Key: v1 }));
    invariant('Cache-Control стоїть на обʼєкті', head.CacheControl === IMMUTABLE);

    const endpoint = h.cfg.endpoint ?? `https://${h.cfg.bucket}.s3.${h.cfg.region}.amazonaws.com`;
    const directUrl = h.cfg.endpoint ? `${endpoint}/${h.cfg.bucket}/${v1}` : `${endpoint}/${v1}`;
    expect('direct', (await fetch(directUrl)).status, [403]);

    const miss = await via(v1);
    expect('edge-miss', miss.status, [200]);
    invariant('перший запит — X-Cache: MISS', miss.headers.get('x-cache') === 'MISS');
    await miss.arrayBuffer();
    const hit = await via(v1);
    expect('edge-hit', hit.status, [200]);
    expect('cache-hit', bool(hit.headers.get('x-cache') === 'HIT'), [1]);
    const body1 = await hit.text();
    invariant('приватні uploads/ через edge недоступні', (await via('uploads/x')).status === 403);

    // «деплой»: той самий app.css, інший вміст
    const v2 = await publishAsset(h.s3, h.cfg.bucket, 'app.css', 'body{color:#222}/* v2 */', 'text/css');
    expect('new-name', bool(v2 !== v1), [1]);
    const fresh = await via(v2);
    expect('new-url', fresh.status, [200]);
    expect('content-changed', bool((await fresh.text()) !== body1), [1]);

    // старий URL нікому не заважає: досі в кеші, нічого не інвалідовували
    invariant('старий запис живий у кеші', (await via(v1)).headers.get('x-cache') === 'HIT');
    console.log('invalidations=0');
  } finally {
    edge.server.close();
    edge.server.closeAllConnections();
    await wipe(h.s3, h.cfg.bucket, ['assets/']);
  }
});
