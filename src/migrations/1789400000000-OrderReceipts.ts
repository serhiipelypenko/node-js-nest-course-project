import { MigrationInterface, QueryRunner } from 'typeorm';

// hw-19: ефект споживача order.placed. event_id — PRIMARY KEY, тож
// INSERT ... ON CONFLICT (event_id) DO NOTHING і є ідемпотентність: повторна
// доставка тієї самої події не створює другого рядка. Сховище — Postgres, а
// не Set у памʼяті: ключі переживають рестарт споживача і спільні для реплік.
export class OrderReceipts1789400000000 implements MigrationInterface {
  name = 'OrderReceipts1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "order_receipts" (
        "event_id" uuid NOT NULL,
        "order_id" text NOT NULL,
        "buyer_id" text NOT NULL,
        "total_amount" numeric(12,2) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_receipts_event_id" PRIMARY KEY ("event_id")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "order_receipts"`);
  }
}
