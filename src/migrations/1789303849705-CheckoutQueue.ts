import { MigrationInterface, QueryRunner } from "typeorm";

export class CheckoutQueue1789303849705 implements MigrationInterface {
    name = 'CheckoutQueue1789303849705'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "job_queue" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "kind" text NOT NULL DEFAULT 'post_processing', "status" text NOT NULL DEFAULT 'new', "worker" text, "processed" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" bigint NOT NULL, CONSTRAINT "CHK_761951a3e133f36408c00e68b8" CHECK ("status" IN ('new', 'done')), CONSTRAINT "PK_276b4a8597badbcd15d9fae6115" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "products" ADD "stock" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "balance" numeric(12,2) NOT NULL DEFAULT '1000000'`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "CHK_aea3ee263e1d44e36e5f5b5783" CHECK ("stock" >= 0)`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_c02441849c51cb89e480be94b1" CHECK ("balance" >= 0)`);
        await queryRunner.query(`ALTER TABLE "job_queue" ADD CONSTRAINT "FK_1a72003ffb581115ff10c57e259" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_queue" DROP CONSTRAINT "FK_1a72003ffb581115ff10c57e259"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_c02441849c51cb89e480be94b1"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "CHK_aea3ee263e1d44e36e5f5b5783"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "stock"`);
        await queryRunner.query(`DROP TABLE "job_queue"`);
    }

}
