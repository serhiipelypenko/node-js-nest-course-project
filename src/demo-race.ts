// hw-14, п.2 — npm run demo:race: щонайменше 50 паралельних checkout()
// (Promise.all, БЕЗ черг у застосунку) на один товар зі stock=10, по 1
// одиниці за виклик. Баланс покупця в цьому демо навмисно надлишковий
// (див. коментар у entities/user.entity.ts) — обмежувати успіх має саме
// stock товару, інакше число успішних стало б залежати від порядку
// виконання, а не дорівнювало б рівно початковому stock.
import 'reflect-metadata';
import { checkout } from './checkout';
import { createDataSource, hdr, note } from './concurrency/lib';

const ATTEMPTS = 60; // >= 50 із постановки
const INITIAL_STOCK = 10;

async function main(): Promise<void> {
  hdr('hw-14 · demo:race — 60 паралельних checkout() на товар зі stock=10');
  const ds = createDataSource(ATTEMPTS + 10);
  await ds.initialize();

  const [product]: Array<{ id: string }> = await ds.query(
    `INSERT INTO products (sku, name, price, stock)
     VALUES ('RACE-DEMO', 'Товар демо-гонки', 100, $1)
     ON CONFLICT (sku) DO UPDATE SET stock = EXCLUDED.stock, price = EXCLUDED.price
     RETURNING id`,
    [INITIAL_STOCK],
  );
  const [buyer]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, full_name)
     VALUES ('race-demo@example.com', 'Покупець демо-гонки')
     ON CONFLICT (email) DO UPDATE SET balance = 1000000
     RETURNING id`,
  );

  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, () =>
      checkout(ds, { buyerId: buyer.id, productId: product.id, quantity: 1 }),
    ),
  );
  const succeeded = results.filter((r) => r.ok).length;

  const [{ stock: finalStockRaw }]: Array<{ stock: string }> = await ds.query(
    `SELECT stock FROM products WHERE id = $1`,
    [product.id],
  );
  const finalStock = Number(finalStockRaw);
  const [{ n: negativeRaw }]: Array<{ n: string }> = await ds.query(
    `SELECT count(*) AS n FROM products WHERE stock < 0`,
  );
  const negativeStockRows = Number(negativeRaw);

  console.log(`спроб: ${ATTEMPTS}`);
  console.log(`успішних: ${succeeded}`);
  console.log(`фінальний stock: ${finalStock}`);
  console.log(`рядків із відʼємним stock: ${negativeStockRows}`);
  note(
    `очікували: успішних === ${INITIAL_STOCK}, фінальний stock === 0, відʼємних рядків === 0`,
  );

  await ds.destroy();

  const oversell =
    succeeded !== INITIAL_STOCK || finalStock !== 0 || negativeStockRows > 0;
  if (oversell) {
    console.error('OVERSELL: інваріант stock >= 0 порушено (або успішних != початковий stock)');
    process.exit(1);
  }
  console.log('OK — жодного oversell.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
