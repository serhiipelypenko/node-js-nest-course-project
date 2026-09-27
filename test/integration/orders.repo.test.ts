import { Order } from '../../src/entities/order.entity';
import { startPg, PgHandle } from '../testkit/pg-container';
import { aUser, aProduct, anOrder } from '../testkit/builders';

interface RevenueRow {
  sku: string;
  units: string;
  revenue: string;
}

/**
 * Репозиторій #2: Order (TypeORM Repository<Order>) — той самий контейнер-на-
 * файл + TRUNCATE-між-тестами, що й products.repo.test.ts.
 */
describe('OrdersRepository (TypeORM) проти справжнього Postgres', () => {
  let pg: PgHandle;

  beforeAll(async () => {
    pg = await startPg('(orders.repo)');
  }, 60_000);

  beforeEach(async () => {
    await pg.truncateAll();
  });

  afterAll(async () => {
    await pg.stop();
  });

  test('створює замовлення з позиціями і читає граф buyer+items+product одним JOIN', async () => {
    const buyer = await aUser().withEmail('ada@example.com').withFullName('Ada Lovelace').insertVia(pg.dataSource);
    const product = await aProduct().withSku('kbd-2').withPrice(500).insertVia(pg.dataSource);
    const created = await anOrder().withBuyer(buyer).withItem(product, 3, 500).insertVia(pg.dataSource);

    // relations: {...} -> один SQL LEFT JOIN на users + order_items + products
    // (той самий підхід, що demo-nplus1.ts "виправлений" варіант hw-13),
    // а не find() + окремі запити в циклі.
    const found = await pg.dataSource.getRepository(Order).findOne({
      where: { id: created.id },
      relations: { buyer: true, items: { product: true } },
    });

    expect(found?.buyer.email).toBe('ada@example.com');
    expect(found?.items).toHaveLength(1);
    expect(found?.items[0]).toMatchObject({ quantity: 3, unitPrice: 500 });
    expect(found?.items[0].product.sku).toBe('kbd-2');
    expect(found?.totalAmount).toBe(1500);
  });

  test('FK constraint: order_item на неіснуючий product_id падає з кодом 23503 (foreign_key_violation)', async () => {
    const order = await anOrder().insertVia(pg.dataSource);

    await expect(
      pg.pool.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
        [order.id, '999999999', 1, 10],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('агрегація: SUM(quantity)/SUM(quantity*unit_price) через createQueryBuilder, GROUP BY товар', async () => {
    const buyer = await aUser().insertVia(pg.dataSource);
    const product = await aProduct().withSku('agg-sku').withPrice(200).insertVia(pg.dataSource);
    // два різні замовлення з тим самим товаром — перевіряємо, що GROUP BY зводить обидва
    await anOrder().withBuyer(buyer).withItem(product, 2, 200).insertVia(pg.dataSource);
    await anOrder().withBuyer(buyer).withItem(product, 1, 200).insertVia(pg.dataSource);

    const rows = await pg.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .innerJoin('order_items', 'oi', 'oi.order_id = o.id')
      .innerJoin('products', 'p', 'p.id = oi.product_id')
      .select('p.sku', 'sku')
      .addSelect('SUM(oi.quantity)', 'units')
      .addSelect('SUM(oi.quantity * oi.unit_price)', 'revenue')
      .where('p.sku = :sku', { sku: 'agg-sku' })
      .groupBy('p.sku')
      .getRawMany<RevenueRow>();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].units)).toBe(3); // 2 + 1
    expect(Number(rows[0].revenue)).toBe(600); // 3 * 200
  });
});
