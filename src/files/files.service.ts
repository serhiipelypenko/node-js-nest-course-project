import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  type Part,
} from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types';
import { PG_POOL } from '../database/database.module';
import { errName, errStatus } from '../storage/s3';
import { MAX_OBJECT, computePartSize, partCount, partLength } from '../storage/limits';
import { CONTENT_TYPES, type FileRow, type PartInfo, type UploadDescriptor } from './files.types';
import { StorageService } from './storage.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// filename приймаємо (клієнт його надсилає), валідуємо — і ВИКИДАЄМО: у ключ
// він не потрапляє. Позначка у схемі, а не в голові читача.
const intentSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(Object.keys(CONTENT_TYPES) as [keyof typeof CONTENT_TYPES, ...(keyof typeof CONTENT_TYPES)[]]),
  size: z.number().int().min(1).max(MAX_OBJECT),
});

const bad = (code: string, detail: string) => new HttpException({ code, detail }, 400);

@Injectable()
export class FilesService {
  private readonly log = new Logger('Files');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly storage: StorageService,
  ) {}

  // ── intent ──────────────────────────────────────────────────────────────
  async intent(user: AuthUser, rawBody: unknown, idempotencyKey?: string): Promise<UploadDescriptor> {
    const parsed = intentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw bad('invalid-intent', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const { contentType, size } = parsed.data;

    // Повторний intent з тим самим Idempotency-Key (подвійний тап) — той самий
    // рядок і той самий ключ обʼєкта, а не другий файл.
    if (idempotencyKey) {
      const { rows } = await this.pool.query<FileRow>(
        `SELECT * FROM files WHERE owner_id = $1 AND idempotency_key = $2`,
        [user.id, idempotencyKey],
      );
      if (rows[0]) return this.describe(rows[0]);
    }

    const id = randomUUID();
    // 🔴 Ключ збирає сервер: userId з токена + uuid + розширення з allowlist.
    // Жодного байта з filename.
    const key = `uploads/${user.id}/${id}.${CONTENT_TYPES[contentType]}`;

    let uploadId: string | null = null;
    if (size > this.storage.multipartThreshold) {
      const r = await this.storage.s3.send(
        new CreateMultipartUploadCommand({ Bucket: this.storage.bucket, Key: key, ContentType: contentType }),
      );
      uploadId = r.UploadId as string;
    }

    try {
      const { rows } = await this.pool.query<FileRow>(
        `INSERT INTO files (id, key, owner_id, status, content_type, size, upload_id, idempotency_key)
         VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7) RETURNING *`,
        [id, key, user.id, contentType, size, uploadId, idempotencyKey ?? null],
      );
      this.log.log(`intent file=${id} key=${key} multipart=${uploadId ? 1 : 0}`);
      return this.describe(rows[0]);
    } catch (err) {
      // не лишаємо multipart-«хвіст», за який платимо, якщо INSERT не вдався
      if (uploadId) {
        await this.storage.s3
          .send(new AbortMultipartUploadCommand({ Bucket: this.storage.bucket, Key: key, UploadId: uploadId }))
          .catch(() => undefined);
      }
      // гонка двох тапів з одним Idempotency-Key: програвший віддає рядок переможця
      if ((err as { code?: string }).code === '23505' && idempotencyKey) {
        const { rows } = await this.pool.query<FileRow>(
          `SELECT * FROM files WHERE owner_id = $1 AND idempotency_key = $2`,
          [user.id, idempotencyKey],
        );
        if (rows[0]) return this.describe(rows[0]);
      }
      throw err;
    }
  }

  // ── resume: що вже на сервері і чого бракує ───────────────────────────────
  async parts(user: AuthUser, id: string) {
    const row = await this.owned(user, id);
    if (!row.upload_id) throw new ConflictException({ code: 'not-multipart', detail: 'це не multipart-завантаження' });
    if (row.status !== 'PENDING') throw new ConflictException({ code: 'already-completed', detail: 'файл уже завершено' });

    const size = Number(row.size);
    const partSize = computePartSize(size);
    const total = partCount(size, partSize);
    const uploaded = await this.listAllParts(row);
    // Частина «є», лише якщо її розмір збігся з очікуваним: коротка = обірвана → долити
    const good = new Map<number, Part>();
    for (const p of uploaded) {
      if (p.Size === partLength(size, partSize, p.PartNumber as number)) good.set(p.PartNumber as number, p);
    }
    const missing: PartInfo[] = [];
    for (let n = 1; n <= total; n++) {
      if (!good.has(n)) {
        missing.push({
          part_number: n,
          length: partLength(size, partSize, n),
          url: await this.storage.presignPart(row.key, row.upload_id, n),
        });
      }
    }
    return {
      id: row.id,
      part_size: partSize,
      part_count: total,
      uploaded: [...good.values()].map((p) => ({ part_number: p.PartNumber, size: p.Size })),
      missing,
      expires_in: this.storage.partExpires,
    };
  }

  // ── commit ──────────────────────────────────────────────────────────────
  async commit(user: AuthUser, id: string) {
    const row = await this.owned(user, id);
    if (row.status === 'COMPLETED') return this.view(row); // повторний commit — той самий результат

    const size = Number(row.size);
    if (row.upload_id) {
      const partSize = computePartSize(size);
      const total = partCount(size, partSize);
      const have = (await this.listAllParts(row)).filter(
        (p) => p.Size === partLength(size, partSize, p.PartNumber as number),
      );
      const haveNums = new Set(have.map((p) => p.PartNumber));
      const missing = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !haveNums.has(n));
      if (missing.length) {
        throw new ConflictException({
          code: 'parts-missing',
          detail: `бракує частин: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`,
        });
      }
      try {
        await this.storage.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.storage.bucket,
            Key: row.key,
            UploadId: row.upload_id,
            MultipartUpload: {
              Parts: have
                .sort((a, b) => (a.PartNumber as number) - (b.PartNumber as number))
                .map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })),
            },
          }),
        );
      } catch (e) {
        // NoSuchUpload: попередній commit встиг зібрати обʼєкт, але не оновив базу —
        // HeadObject нижче все одно скаже правду
        if (errName(e) !== 'NoSuchUpload') throw e;
      }
    }

    // 🔴 Без цього кроку клієнт «комітить» те, чого не заливав.
    let head;
    try {
      head = await this.storage.s3.send(new HeadObjectCommand({ Bucket: this.storage.bucket, Key: row.key }));
    } catch (e) {
      if (errStatus(e) === 404 || errName(e) === 'NotFound') {
        throw new ConflictException({ code: 'object-missing', detail: 'у сховищі немає обʼєкта — байти не завантажено' });
      }
      throw e;
    }
    if (head.ContentLength !== size) {
      throw new ConflictException({
        code: 'size-mismatch',
        detail: `розмір у сховищі ${head.ContentLength} Б, очікувався ${size} Б`,
      });
    }

    const { rows } = await this.pool.query<FileRow>(
      `UPDATE files SET status = 'COMPLETED', etag = $2, completed_at = now()
        WHERE id = $1 RETURNING *`,
      [row.id, head.ETag ?? null],
    );
    this.log.log(`commit file=${row.id} key=${row.key}`);
    return this.view(rows[0]);
  }

  // ── GET /files/:id -> 302 на свіжий presigned (хвилина) ───────────────────
  // Presigned не можна відкликати, тому в листи й сторінки кладемо цей
  // ендпоінт, а не сам URL: гард відпрацьовує на КОЖЕН запит.
  async downloadUrl(user: AuthUser, id: string): Promise<string> {
    const row = await this.owned(user, id);
    if (row.status !== 'COMPLETED') throw new ConflictException({ code: 'not-completed', detail: 'файл ще не завершено' });
    return this.storage.presignGet(row.key);
  }

  // ── внутрішнє ───────────────────────────────────────────────────────────
  /** Рівень ВЛАСНОСТІ (гард ролі ресурсу не знає) — як getOwned у OrdersService. */
  private async owned(user: AuthUser, id: string): Promise<FileRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException({ code: 'file-not-found', detail: 'файл не знайдено' });
    const { rows } = await this.pool.query<FileRow>(`SELECT * FROM files WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'file-not-found', detail: 'файл не знайдено' });
    if (row.owner_id !== user.id && user.role !== 'admin') {
      throw new ForbiddenException({ code: 'not-owner', detail: 'це не ваш файл' });
    }
    return row;
  }

  /** ListParts віддає ≤ 1000 частин за виклик — ходимо по маркеру. */
  private async listAllParts(row: FileRow): Promise<Part[]> {
    const out: Part[] = [];
    let marker: string | undefined;
    for (;;) {
      const r = await this.storage.s3.send(
        new ListPartsCommand({
          Bucket: this.storage.bucket,
          Key: row.key,
          UploadId: row.upload_id as string,
          PartNumberMarker: marker,
        }),
      );
      out.push(...(r.Parts ?? []));
      if (!r.IsTruncated) return out;
      marker = r.NextPartNumberMarker;
    }
  }

  private async describe(row: FileRow): Promise<UploadDescriptor> {
    const base = { id: row.id, key: row.key, status: row.status };
    const size = Number(row.size);
    if (!row.upload_id) {
      return {
        ...base,
        expires_in: this.storage.putExpires,
        method: 'PUT',
        url: await this.storage.presignPut(row.key, row.content_type),
        headers: { 'Content-Type': row.content_type },
      };
    }
    const partSize = computePartSize(size);
    const total = partCount(size, partSize);
    const parts: PartInfo[] = [];
    for (let n = 1; n <= total; n++) {
      parts.push({
        part_number: n,
        length: partLength(size, partSize, n),
        url: await this.storage.presignPart(row.key, row.upload_id, n),
      });
    }
    return {
      ...base,
      expires_in: this.storage.partExpires,
      multipart: { upload_id: row.upload_id, part_size: partSize, part_count: total, parts },
    };
  }

  private view(row: FileRow) {
    return { id: row.id, key: row.key, status: row.status, size: Number(row.size), etag: row.etag };
  }
}
