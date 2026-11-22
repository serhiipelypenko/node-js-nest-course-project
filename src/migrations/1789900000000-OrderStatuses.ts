import { MigrationInterface, QueryRunner } from 'typeorm';

// Курсовий: HTTP-контур (Nest) переходить з in-memory на Postgres. Життєвий
// цикл API — new -> packed -> shipped -> delivered | cancelled; у БД «new» —
// це `paid` (checkout списує кошти одразу), тож додаємо лише два статуси, яких
// бракувало: `packed` і `delivered`. Старі значення лишаються валідними.
export class OrderStatuses1789900000000 implements MigrationInterface {
  name = 'OrderStatuses1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "CHK_761019fb76eb9b866e3c45b42d"`);
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_761019fb76eb9b866e3c45b42d" CHECK ("status" IN ('pending', 'paid', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Відкат: рядки з новими статусами повертаємо до найближчого старого,
    // інакше старий CHECK не накотиться на непорожню таблицю.
    await queryRunner.query(`UPDATE "orders" SET "status" = 'paid' WHERE "status" = 'packed'`);
    await queryRunner.query(`UPDATE "orders" SET "status" = 'shipped' WHERE "status" = 'delivered'`);
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "CHK_761019fb76eb9b866e3c45b42d"`);
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_761019fb76eb9b866e3c45b42d" CHECK ("status" IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded'))`,
    );
  }
}
