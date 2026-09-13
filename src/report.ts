// Звіт "виторг по товарах": SUM + GROUP BY + JOIN order_items -> products.
// find()/Repository такого не вміє — тут результат не граф entity, а рядки
// звіту з обчисленими агрегатами, тому createQueryBuilder().getRawMany().
import 'reflect-metadata';
import AppDataSource from './data-source';
import { Product } from './entities/product.entity';

interface RevenueRow {
  sku: string;
  name: string;
  units: string; // SUM(int) повертається bigint-рядком
  revenue: string; // SUM(numeric) теж рядком — see numeric.transformer.ts
}

async function main() {
  await AppDataSource.initialize();

  const rows = await AppDataSource.getRepository(Product)
    .createQueryBuilder('p')
    .innerJoin('order_items', 'oi', 'oi.product_id = p.id')
    .select('p.sku', 'sku')
    .addSelect('p.name', 'name')
    .addSelect('SUM(oi.quantity)', 'units')
    .addSelect('SUM(oi.quantity * oi.unit_price)', 'revenue')
    .groupBy('p.id')
    .addGroupBy('p.sku')
    .addGroupBy('p.name')
    .orderBy('revenue', 'DESC')
    .getRawMany<RevenueRow>();

  console.log('Виторг за товарами (SUM(quantity), SUM(quantity * unit_price) по order_items, GROUP BY product):\n');
  console.table(
    rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      units: Number(r.units),
      revenue: Number(r.revenue).toFixed(2),
    })),
  );

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
