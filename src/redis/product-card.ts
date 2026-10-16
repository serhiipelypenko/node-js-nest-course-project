import { DataSource } from 'typeorm';

// «Важке» читання hw-23: картка товару = товар + рейтинг (AVG по відгуках) +
// залишок. Це JOIN + агрегат, а не PK-lookup — його і має сенс кешувати.
export interface ProductCard {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  rating: number;
  reviews: number;
}

interface CardRow {
  id: string;
  sku: string;
  name: string;
  price: string;
  stock: number;
  rating: string;
  reviews: string;
}

/**
 * Єдине місце, де картка читається з бази. Кожен виклик = рівно один SQL;
 * «скільки разів сходили в базу» рахується НЕ тут, а на рівні драйвера
 * (QueryCountLogger у DataSource демо) — функція-обгортка не може збрехати
 * про власні виклики.
 */
export async function loadProductCard(ds: DataSource, id: string): Promise<ProductCard | null> {
  const rows: CardRow[] = await ds.query(
    `SELECT p.id, p.sku, p.name, p.price, p.stock,
            COALESCE(ROUND(AVG(r.rating), 2), 0) AS rating,
            COUNT(r.id) AS reviews
       FROM products p
       LEFT JOIN reviews r ON r.product_id = p.id
      WHERE p.id = $1
      GROUP BY p.id`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: Number(row.price),
    stock: row.stock,
    rating: Number(row.rating),
    reviews: Number(row.reviews),
  };
}
