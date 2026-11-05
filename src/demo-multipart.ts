// demo:multipart — multipart це ВІДНОВЛЕННЯ, а не «підтримка великих файлів».
//
// Файл 11 МіБ = 3 частини (5 + 5 + 1). Перший процес заливає дві і вмирає
// SIGKILL. Другий питає ListParts (через API) і доливає тільки третю.
//
//   head-before-complete=404  частини вже лежать, а обʼєкта ще НЕМАЄ
//   resumed-parts=1           другий процес долив 1 частину (без ListParts було б 3)
//   complete=200              commit зібрав обʼєкт (CompleteMultipartUpload) і звірив розмір
//   size-match=1              HeadObject.ContentLength == розмір файла
//   etag-multipart=1          ETag має суфікс -3 і НЕ дорівнює MD5 файла
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { bool, expect, invariant, run, wipe } from './files/demo-lib';
import { MIB, computePartSize, partCount, partLength } from './storage/limits';

const exec = promisify(execFile);
const CLIENT = join(__dirname, 'files', 'client-mpu.js');
const TOTAL = 11 * MIB;

const headStatus = (h: { s3: any; cfg: { bucket: string } }, key: string): Promise<number> =>
  h.s3.send(new HeadObjectCommand({ Bucket: h.cfg.bucket, Key: key })).then(() => 200, (e: any) => e?.$metadata?.httpStatusCode ?? 0);

void run('demo:multipart', true, async (h) => {
  // чистий аркуш: і обʼєкти, і НЕЗАВЕРШЕНІ multipart (інакше другий прогін бачить хвости першого)
  await wipe(h.s3, h.cfg.bucket, ['uploads/']);
  await h.user('demo-mpu@files.test', 'customer');

  const { base } = await h.startApi();
  const token = await h.login(base, 'demo-mpu@files.test');

  // розмір частини — порахований, не константа
  const partSize = computePartSize(TOTAL);
  invariant('3 частини по 5/5/1 МіБ', partSize === 5 * MIB && partCount(TOTAL, partSize) === 3);

  // ── перший процес: дві частини і SIGKILL ────────────────────────────────
  let out = '';
  try {
    out = (await exec(process.execPath, [CLIENT, 'start', base, token, String(TOTAL), '2'], { env: {} })).stdout;
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? ''); // його вбито — це і є мета
  }
  const id = out.match(/^ID (\S+)/m)?.[1] ?? '';
  invariant('перший процес встиг залити рівно 2 частини і вмер', /DIE/.test(out) && (out.match(/^PART /gm) ?? []).length === 2);
  const { rows } = await h.pool.query<{ key: string }>('SELECT key FROM files WHERE id = $1', [id]);
  const key = rows[0]?.key ?? '';

  // частини на сервері є, обʼєкта немає
  expect('head-before-complete', await headStatus(h, key), [404]);

  // ── другий процес: ListParts -> долити лише бракуюче ──────────────────────
  const res = await exec(process.execPath, [CLIENT, 'resume', base, token, id], { env: {} });
  expect('resumed-parts', (res.stdout.match(/^REUPLOAD /gm) ?? []).length, [1]);
  invariant('другий процес побачив частини 1,2', /^HAVE 1,2$/m.test(res.stdout));

  // ── commit: Complete + HeadObject ───────────────────────────────────────────
  const commit = await h.call(base, 'POST', '/uploads/commit', { token, body: { id } });
  expect('complete', commit.status, [200]);
  const head = await h.s3.send(new HeadObjectCommand({ Bucket: h.cfg.bucket, Key: key }));
  expect('size-match', bool(head.ContentLength === TOTAL), [1]);

  // ETag multipart = MD5(MD5(частин)...)-N, а не MD5 файла
  const whole = Buffer.concat([1, 2, 3].map((n) => Buffer.alloc(partLength(TOTAL, partSize, n), 96 + n)));
  const md5 = createHash('md5').update(whole).digest('hex');
  const etag = (head.ETag ?? '').replace(/"/g, '');
  expect('etag-multipart', bool(/-3$/.test(etag) && etag !== md5), [1]);

  await h.stopApi();
  await wipe(h.s3, h.cfg.bucket, ['uploads/']);
  await h.pool.query('TRUNCATE files');
});
