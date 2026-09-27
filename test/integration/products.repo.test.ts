import { QueryFailedError } from 'typeorm';
import { Product } from '../../src/entities/product.entity';
import { startPg, PgHandle } from '../testkit/pg-container';
import { aProduct } from '../testkit/builders';

/**
 * Репозиторій #1: Product (TypeORM Repository<Product>) проти справжнього
 * Postgres у testcontainers — та сама схема, що й dev/prod (dist/migrations).
 *
 * Ізоляція: один контейнер на цей файл (beforeAll), TRUNCATE усіх таблиць
 * домену між тестами (beforeEach) — див. README, розділ «Тестування».
 */
describe('ProductsRepository (TypeORM) проти справжнього Postgres', () => {
  let pg: PgHandle;

  beforeAll(async () => {
    pg = await startPg('(products.repo)');
  }, 60_000);

  beforeEach(async () => {
    await pg.truncateAll();
  });

  afterAll(async () => {
    await pg.stop();
  });

  test('створює товар і знаходить його за sku', async () => {
    const created = await aProduct().withSku('kbd-1').withName('Клавіатура').withPrice(1299).insertVia(pg.dataSource);

    const found = await pg.dataSource.getRepository(Product).findOneBy({ sku: 'kbd-1' });
    expect(found).toMatchObject({ id: created.id, sku: 'kbd-1', name: 'Клавіатура', price: 1299 });
  });

  test('unique constraint: дублікат sku падає з кодом 23505 (unique_violation)', async () => {
    await aProduct().withSku('dup-sku').insertVia(pg.dataSource);

    await expect(aProduct().withSku('dup-sku').insertVia(pg.dataSource)).rejects.toMatchObject({
      code: '23505', // unique_violation — той самий constraint, що на "sku" у db/schema.sql (hw-12) і в entity (hw-13)
    });
  });

  test('ON CONFLICT: upsert за sku оновлює існуючий рядок замість дублювання', async () => {
    const repo = pg.dataSource.getRepository(Product);
    await repo.upsert({ sku: 'upsert-sku', name: 'Версія 1', price: 100, stock: 5 }, ['sku']);
    await repo.upsert({ sku: 'upsert-sku', name: 'Версія 2', price: 150, stock: 5 }, ['sku']);

    const rows = await repo.findBy({ sku: 'upsert-sku' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Версія 2', price: 150 });
  });

  test('QueryFailedError від pg зберігає SQLSTATE у полі code', async () => {
    await aProduct().withSku('again').insertVia(pg.dataSource);
    try {
      await aProduct().withSku('again').insertVia(pg.dataSource);
      throw new Error('мало кинути помилку unique constraint');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryFailedError);
      expect((err as { code?: string }).code).toBe('23505');
    }
  });
});
