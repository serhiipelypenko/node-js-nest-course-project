// Спільне для demo:outbox / demo:crash-write / demo:crash-relay.
// Кожне демо саме приводить стан до чистого: міграції, топологія, спорожнені
// черги й таблиці outbox/inbox/ефектів (resetState) + власні покупець і товар,
// чиї замовлення видаляються, щоб лічильник orders=… рахував лише це демо.
import { DataSource } from 'typeorm';
import { resetState } from '../messaging/demo-lib';

export interface DemoWorld {
  ds: DataSource;
  buyerId: string;
  productId: string;
}

export const DEMO_STOCK = 100;
export const DEMO_PRICE = 100;

export async function prepareWorld(tag: string): Promise<DemoWorld> {
  const ds = await resetState();
  const [product]: Array<{ id: string }> = await ds.query(
    `INSERT INTO products (sku, name, price, stock)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sku) DO UPDATE SET stock = EXCLUDED.stock, price = EXCLUDED.price
     RETURNING id`,
    [`OUTBOX-${tag}`, `Товар демо ${tag}`, DEMO_PRICE, DEMO_STOCK],
  );
  const [buyer]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, full_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET balance = 1000000
     RETURNING id`,
    [`outbox-${tag}@example.com`, `Покупець демо ${tag}`],
  );
  // order_items / job_queue / idempotency_keys зникають каскадом
  await ds.query(`DELETE FROM orders WHERE buyer_id = $1`, [buyer.id]);
  return { ds, buyerId: buyer.id, productId: product.id };
}

async function count(ds: DataSource, sql: string, params: unknown[] = []): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(sql, params);
  return Number(rows[0].n);
}

export const countOrders = (ds: DataSource, buyerId: string) =>
  count(ds, `SELECT count(*) AS n FROM orders WHERE buyer_id = $1`, [buyerId]);
export const countOutbox = (ds: DataSource) => count(ds, `SELECT count(*) AS n FROM outbox`);
export const countPublished = (ds: DataSource) =>
  count(ds, `SELECT count(*) AS n FROM outbox WHERE published_at IS NOT NULL`);
export const countProcessed = (ds: DataSource) => count(ds, `SELECT count(*) AS n FROM processed_messages`);

export async function stockOf(ds: DataSource, productId: string): Promise<number> {
  return count(ds, `SELECT stock AS n FROM products WHERE id = $1`, [productId]);
}
