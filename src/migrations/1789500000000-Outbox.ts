import { MigrationInterface, QueryRunner } from 'typeorm';

// hw-22: transactional outbox + ідемпотентність на трьох рівнях.
//
// outbox — набір полів і їх ролі як у Debezium Outbox Event Router:
//   aggregate_type -> куди маршрутизувати (у Debezium: route.by.field),
//   aggregate_id   -> ключ партиціонування/порядку (table.field.event.key),
//   type           -> назва події, payload -> тіло.
// ⚠️ Канонічні імена в Debezium БЕЗ підкреслень (aggregatetype, aggregateid),
// і саме `aggregatetype` стоїть у route.by.field за замовчуванням. Тут
// snake_case для читабельності: при переїзді на CDC або перейменовуємо колонки,
// або явно виставляємо route.by.field / table.field.event.key в конфізі
// конектора. Ролі полів від цього не міняються — міняється лише конфіг.
//
// published_at IS NULL = «ще не винесено». Частковий індекс покриває рівно
// запит relay (WHERE published_at IS NULL ORDER BY created_at, id): таблиця
// росте, а «хвіст» невинесених — ні, тож індекс лишається крихітним.
//
// processed_messages — inbox консюмера (рівень 2): складений ключ
// (message_id, consumer), бо те саме повідомлення різні консюмери обробляють
// кожен окремо.
//
// idempotency_keys — рівень 3, API-край. Ключ ідентифікує НАМІР клієнта, а не
// тіло запиту. order_id nullable лише всередині транзакції checkout: рядок
// спочатку «займає» ключ, а order_id дописується після INSERT замовлення —
// в ЗАКОМІЧЕНОМУ стані NULL не буває.
//
// Унікальність order_receipts.order_id — природний ключ ефекту (рівень 1):
// «на замовлення — одна квитанція», незалежно від того, скільки разів і під
// яким event_id прийшла подія.
export class Outbox1789500000000 implements MigrationInterface {
  name = 'Outbox1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "aggregate_type" text NOT NULL,
        "aggregate_id" text NOT NULL,
        "type" text NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "published_at" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_outbox_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_unpublished" ON "outbox" ("created_at", "id") WHERE "published_at" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "processed_messages" (
        "message_id" uuid NOT NULL,
        "consumer" text NOT NULL,
        "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_processed_messages" PRIMARY KEY ("message_id", "consumer")
      )`,
    );

    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" (
        "key" text NOT NULL,
        "order_id" bigint,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("key"),
        CONSTRAINT "FK_idempotency_keys_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_order_receipts_order_id" ON "order_receipts" ("order_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_order_receipts_order_id"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "processed_messages"`);
    await queryRunner.query(`DROP INDEX "IDX_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
  }
}
