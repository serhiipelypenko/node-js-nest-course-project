import { MigrationInterface, QueryRunner } from 'typeorm';

// hw-23: відгуки — джерело «рейтингу» для важкого читання (картка товару).
// Картка = товар + AVG(rating) + COUNT(*) по відгуках + поточний залишок:
// агрегат по дочірній таблиці, тобто саме те читання, яке дорого рахувати
// щоразу і яке змінюється рідко — класичний кандидат у cache-aside.
// Окремої entity немає: відгуки читає лише SQL картки (src/redis/product-card.ts).
export class Reviews1789600000000 implements MigrationInterface {
  name = 'Reviews1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "reviews" (
        "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
        "product_id" bigint NOT NULL,
        "rating" smallint NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5),
        CONSTRAINT "FK_reviews_product" FOREIGN KEY ("product_id")
          REFERENCES "products"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_reviews_product" ON "reviews" ("product_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reviews"`);
  }
}
