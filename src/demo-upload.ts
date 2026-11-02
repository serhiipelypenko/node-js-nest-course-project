// demo:upload — байти йдуть ПОВЗ наш сервіс; commit чесний; підпис накриває шлях і час.
//
//   intent=200              двокроковий контракт: намір -> presigned URL
//   key-from-server=1       ключ зібрав сервер; шкідливе filename `../../etc/passwd` до нього не доїхало
//   api-alive=0             наш застосунок ЗУПИНЕНО (перевірка сирим сокетом)
//   put-offline=200         PUT робить окремий процес БЕЗ жодного ключа -> байти доїхали без нас
//   commit=200              API піднято назад (НОВИЙ порт); HeadObject підтвердив
//   commit-without-bytes=409  намір є, байтів немає, commit -> відмова (без HeadObject було б 200)
//   tampered=403            у presigned URL підмінено ключ -> SignatureDoesNotMatch
//   expired=403             той самий URL після протермінування
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bool, expect, invariant, portAlive, run, sleep, wipe } from './files/demo-lib';
import { StorageService } from './files/storage.service';

const exec = promisify(execFile);
const CLIENT_PUT = join(__dirname, 'files', 'client-put.js');
const BYTES = 2048;

void run('demo:upload', true, async (h) => {
  await wipe(h.s3, h.cfg.bucket, ['uploads/']);
  const userId = await h.user('demo-uploader@files.test', 'customer');

  // ── 1. intent: ключ збирає сервер ────────────────────────────────────────
  const first = await h.startApi();
  const token = await h.login(first.base, 'demo-uploader@files.test');
  const evil = '../../etc/passwd';
  const intent = await h.call(first.base, 'POST', '/uploads/intent', {
    token,
    headers: { 'Idempotency-Key': 'demo-upload-1' },
    body: { filename: evil, contentType: 'image/png', size: BYTES },
  });
  expect('intent', intent.status, [200]);
  const { id, key, url } = intent.body as { id: string; key: string; url: string };
  const keyOk = new RegExp(`^uploads/${userId}/[0-9a-f-]{36}\\.png$`).test(key) && !key.includes('passwd') && !key.includes('..');
  expect('key-from-server', bool(keyOk), [1]);

  // повторний intent з тим самим Idempotency-Key -> той самий обʼєкт (подвійний тап)
  const again = await h.call(first.base, 'POST', '/uploads/intent', {
    token,
    headers: { 'Idempotency-Key': 'demo-upload-1' },
    body: { filename: evil, contentType: 'image/png', size: BYTES },
  });
  invariant('Idempotency-Key повертає той самий файл', again.body?.id === id);
  const rows = await h.pool.query('SELECT 1 FROM files');
  invariant('у базі рівно один рядок після подвійного intent', rows.rowCount === 1);

  // ── 2. API вимкнено; байти їдуть у сховище без нас ──────────────────────────
  await h.stopApi();
  expect('api-alive', bool(await portAlive(first.port)), [0]);
  // env: {} — у клієнта немає ні STORAGE_*, ні JWT, ні чого б то не було
  const put = await exec(process.execPath, [CLIENT_PUT, url, 'image/png', String(BYTES)], { env: {} });
  expect('put-offline', Number(put.stdout.trim()), [200]);

  // ── 3. API назад — на ІНШОМУ порту ────────────────────────────────────────
  const second = await h.startApi();
  invariant('новий порт', second.port !== first.port);
  const commit = await h.call(second.base, 'POST', '/uploads/commit', { token, body: { id } });
  expect('commit', commit.status, [200]);
  const st = await h.pool.query<{ status: string }>('SELECT status FROM files WHERE id = $1', [id]);
  invariant('у базі COMPLETED', st.rows[0]?.status === 'COMPLETED');

  // читання: GET /files/:id -> 302 на свіжий presigned, байти ті самі
  const redirect = await h.call(second.base, 'GET', `/files/${id}`, { token, manual: true });
  invariant('GET /files/:id -> 302', redirect.status === 302);
  const dl = await fetch(redirect.headers.get('location') as string);
  const got = Buffer.from(await dl.arrayBuffer());
  invariant('скачані байти збігаються', got.length === BYTES && got.every((b) => b === 'u'.charCodeAt(0)));

  // ── 4. commit без байтів ──────────────────────────────────────────────────
  const empty = await h.call(second.base, 'POST', '/uploads/intent', {
    token, body: { filename: 'x.png', contentType: 'image/png', size: BYTES },
  });
  const cwb = await h.call(second.base, 'POST', '/uploads/commit', { token, body: { id: empty.body.id } });
  expect('commit-without-bytes', cwb.status, [409]);

  // ── 5. підпис накриває шлях ───────────────────────────────────────────────
  const victim = await h.call(second.base, 'POST', '/uploads/intent', {
    token, body: { filename: 'v.png', contentType: 'image/png', size: BYTES },
  });
  const u = new URL(victim.body.url as string);
  const last = u.pathname.length - 1 - '.png'.length; // остання літера uuid в імені
  u.pathname = u.pathname.slice(0, last) + (u.pathname[last] === 'a' ? 'b' : 'a') + u.pathname.slice(last + 1);
  const tampered = await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(BYTES) });
  expect('tampered', tampered.status, [403]);

  // ── 6. після протермінування той самий URL -> 403 ─────────────────────────
  // Той самий механізм, що й в intent, але строк 1 с (чекати 5 хв у демо нема сенсу).
  const storage = second.app.get(StorageService);
  const shortUrl = await storage.presignPut(victim.body.key as string, 'image/png', 1);
  const okBefore = await fetch(shortUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(BYTES) });
  invariant('до протермінування URL працює', okBefore.status === 200);
  await sleep(2500);
  const expired = await fetch(shortUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(BYTES) });
  expect('expired', expired.status, [403]);

  await h.stopApi();
  await wipe(h.s3, h.cfg.bucket, ['uploads/']);
  await h.pool.query('TRUNCATE files');
});
