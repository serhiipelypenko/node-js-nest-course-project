// hw-26: публікація публічного ассета з ХЕШЕМ ВМІСТУ в імені.
//
//   app.css (вміст A) -> assets/app.15c42ab7.css
//   app.css (вміст B) -> assets/app.9f3a01de.css   <- інше імʼя = інший URL = інша кеш-комірка
//
// Тому «деплой» не потребує інвалідації: старий запис у кеші нікому не заважає
// (на нього вже ніхто не посилається), новий — просто ще не закешований.
// Cache-Control ставиться на ОБʼЄКТ при завантаженні, а не в edge: кеш-шар
// лише читає те, що сказав origin (RFC 9111). Без нього кешувати нічого.
import { createHash } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export const ASSET_PREFIX = 'assets/';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** `app.css` + вміст -> `assets/app.<8 hex sha256>.css`. */
export function hashedKey(name: string, body: Buffer | string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return `${ASSET_PREFIX}${stem}.${hash}${ext}`;
}

export async function publishAsset(
  s3: S3Client,
  bucket: string,
  name: string,
  body: Buffer | string,
  contentType: string,
): Promise<string> {
  const key = hashedKey(name, body);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: IMMUTABLE }),
  );
  return key;
}
