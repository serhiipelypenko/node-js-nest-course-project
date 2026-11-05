import { MigrationInterface, QueryRunner } from 'typeorm';

// hw-26: таблиця файлів. Список файлів користувача живе в БАЗІ, а не в
// сховищі: ListObjectsV2 платний, повільний (1 000 ключів за виклик) і не знає
// власника. Сховище — лише байти; хто чий і в якому стані — тут.
//
//  status  PENDING   — intent видано, байтів може ще не бути (або вже є, але
//                      commit не викликали). COMPLETED — commit зробив
//                      HeadObject і розмір збігся. Без commit обʼєкт для нас
//                      «сирота»: у сховищі лежить, у базі не підтверджений.
//  key     генерує СЕРВЕР (uploads/{userId}/{uuid}.{ext}); filename клієнта
//          сюди не потрапляє, тому в таблиці його немає взагалі.
//  size    ОЧІКУВАНИЙ розмір із intent; commit звіряє його з ContentLength.
//  upload_id  UploadId multipart-завантаження (NULL для звичайного PUT).
//  idempotency_key  подвійний тап по кнопці не має давати два обʼєкти (ДЗ #22):
//          UNIQUE (owner_id, idempotency_key) — повторний intent повертає той самий рядок.
export class Files1789800000000 implements MigrationInterface {
  name = 'Files1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "files" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" text NOT NULL,
        "owner_id" bigint NOT NULL,
        "status" text NOT NULL DEFAULT 'PENDING',
        "content_type" text NOT NULL,
        "size" bigint NOT NULL,
        "upload_id" text,
        "etag" text,
        "idempotency_key" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        CONSTRAINT "PK_files" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_files_key" UNIQUE ("key"),
        CONSTRAINT "CHK_files_status" CHECK ("status" IN ('PENDING', 'COMPLETED')),
        CONSTRAINT "CHK_files_size" CHECK ("size" > 0),
        CONSTRAINT "FK_files_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    // «Файли користувача» (гарячий запит UI): WHERE owner_id = $1 ORDER BY created_at DESC.
    await queryRunner.query(
      `CREATE INDEX "IDX_files_owner_created" ON "files" ("owner_id", "created_at" DESC)`,
    );
    // Прибиральник сиріт: WHERE status = 'PENDING' AND created_at < now() - '1 day'.
    // Частковий індекс — у ньому лише недороблене, а це мала частка таблиці.
    await queryRunner.query(
      `CREATE INDEX "IDX_files_pending" ON "files" ("created_at") WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_files_idempotency" ON "files" ("owner_id", "idempotency_key")
         WHERE "idempotency_key" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "files"`);
  }
}
