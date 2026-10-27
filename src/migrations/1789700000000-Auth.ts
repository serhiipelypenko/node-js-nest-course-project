import { MigrationInterface, QueryRunner } from 'typeorm';

// hw-24: автентифікація. Три речі, і всі — міграцією (synchronize: false):
//
//  1. users.password_hash + users.role. Додаємо колонки до існуючої таблиці
//     hw-13, а не створюємо нову: користувач один. password_hash NULL-able —
//     seed hw-13 не знає паролів (такий користувач просто не може залогінитись).
//     role — CHECK, а не enum-тип: дописати роль = змінити CHECK, а не
//     ALTER TYPE.
//  2. refresh_tokens — рядок на КОЖЕН виданий refresh. Зберігаємо не токен, а
//     його HMAC (token_hash). family_id обʼєднує всі токени одного логіна —
//     саме за ним відкликається вся сімʼя при повторі. used_at ≠ revoked_at:
//     «використаний» (чесна ротація) і «відкликаний» (компрометація/логаут) —
//     різні події, і повтор розпізнається саме як used_at IS NOT NULL.
//  3. access_denylist — jti відкликаних access-токенів. Живе в тій самій базі,
//     що й refresh_tokens, щоб логаут (revoked_at + денилист) був ОДНИМ
//     COMMIT, а не dual write (ДЗ #22).
export class Auth1789700000000 implements MigrationInterface {
  name = 'Auth1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "password_hash" text`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "role" text NOT NULL DEFAULT 'customer'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_role"
         CHECK ("role" IN ('customer', 'seller', 'admin'))`,
    );

    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" (
        "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
        "token_hash" text NOT NULL,
        "family_id" uuid NOT NULL,
        "user_id" bigint NOT NULL,
        "used_at" timestamptz,
        "revoked_at" timestamptz,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    // Пошук за хешем — єдиний гарячий запит refresh (WHERE token_hash = $1).
    // UNIQUE: HMAC від 256-бітного випадкового рядка не колідує, а дубль
    // означав би баг видачі, який краще впустити в INSERT, ніж мовчки пустити.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`,
    );
    // Відкликання сімʼї: UPDATE … WHERE family_id = $1.
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_family" ON "refresh_tokens" ("family_id")`,
    );

    await queryRunner.query(
      `CREATE TABLE "access_denylist" (
        "jti" uuid NOT NULL,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "PK_access_denylist" PRIMARY KEY ("jti")
      )`,
    );
    // Під очищення: DELETE … WHERE expires_at < now().
    await queryRunner.query(
      `CREATE INDEX "IDX_access_denylist_expires" ON "access_denylist" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "access_denylist"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
  }
}
