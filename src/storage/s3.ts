// hw-26: єдина фабрика S3-клієнта для сервера, edge і демо. Ні endpoint, ні
// імена змінних, ні вендор тут не зашиті: порожній endpoint = справжній AWS S3,
// заданий = емулятор (MinIO/LocalStack) чи R2.
import { S3Client } from '@aws-sdk/client-s3';

export interface StorageConfig {
  /** Порожньо => AWS S3. */
  endpoint?: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function makeS3(cfg: StorageConfig): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint || undefined,
    // емуляторам потрібен path-style (/bucket/key); на AWS — virtual-hosted
    forcePathStyle: Boolean(cfg.endpoint),
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    // 🔴 presigned підписується, коли тіла ще немає: за замовчуванням SDK
    // кладе в query суму порожніх даних (x-amz-checksum-crc32=AAAAAA==), і
    // справжнє тіло її не пройде. WHEN_REQUIRED — суму лише там, де її вимагає API.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

/**
 * Конфіг для коду ПОЗА Nest (демо, edge-main): ті самі змінні, що й в
 * env.schema.ts, але з process.env напряму, як DB_* у CLI-шляху B.
 * Дефолтів для секретів немає — відсутнє імʼя називаємо у помилці.
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const need = ['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY', 'STORAGE_BUCKET'];
  const missing = need.filter((n) => !env[n]);
  if (missing.length) {
    throw new Error(
      `не задано ${missing.join(', ')}. Запускай через \`bash scripts/with-secrets.sh dev …\` ` +
        'або з SKIP_VAULT=1 і своїми значеннями (README, ## Grading).',
    );
  }
  return {
    endpoint: env.STORAGE_ENDPOINT || undefined,
    region: env.STORAGE_REGION || 'us-east-1',
    accessKey: env.STORAGE_ACCESS_KEY as string,
    secretKey: env.STORAGE_SECRET_KEY as string,
    bucket: env.STORAGE_BUCKET as string,
  };
}

/** Імʼя помилки S3: SDK кладе його в `name`, емулятори інколи — в `Code`. */
export function errName(e: unknown): string {
  const o = e as { name?: string; Code?: string; message?: string };
  return o?.name ?? o?.Code ?? String(o?.message ?? e);
}

/** HTTP-статус помилки SDK (HeadObject не має тіла, тож name = 'NotFound'). */
export function errStatus(e: unknown): number {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;
}
