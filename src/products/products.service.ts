import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { decodeKeyCursor, keysetPage, Page } from '../common/cursor';
import { PG_POOL } from '../database/database.module';

export interface Product {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
}

// Каталог живе в таблиці products (hw-12/13). API говорить у копійках (integer,
// без float), БД зберігає numeric(12,2): перерахунок робить SQL, а не JS —
// `round(price * 100)` на numeric точний.
const COLUMNS = `id::text AS id, name, round(price * 100)::int AS price_cents, stock`;

// Ідентифікатор у шляху — bigint. Не-число ніколи не доходить до SQL (інакше
// Postgres відповів би 22P02 -> 500), а чесно дає 404.
export function isDbId(id: string): boolean {
  return /^\d{1,18}$/.test(id);
}

@Injectable()
export class ProductsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(limit: number, cursor?: string): Promise<Page<Product>> {
    const after = cursor ? decodeKeyCursor(cursor) : '0';
    const { rows } = await this.pool.query<Product>(
      `SELECT ${COLUMNS} FROM products
       WHERE is_active AND id > $1
       ORDER BY id
       LIMIT $2`,
      [after, limit + 1],
    );
    return keysetPage(rows, limit);
  }

  async getById(id: string): Promise<Product> {
    const rows = isDbId(id)
      ? (await this.pool.query<Product>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id])).rows
      : [];
    if (rows.length === 0) {
      throw new NotFoundException({ detail: `товар "${id}" не знайдено` });
    }
    return rows[0]!;
  }

  async create(name: string, priceCents: number, stock = 0): Promise<Product> {
    // sku — NOT NULL UNIQUE у схемі; для товару з API генеруємо його сервером.
    const { rows } = await this.pool.query<Product>(
      `INSERT INTO products (sku, name, price, stock)
       VALUES ($1, $2, $3::numeric / 100, $4)
       RETURNING ${COLUMNS}`,
      [`api-${randomUUID()}`, name, priceCents, stock],
    );
    return rows[0]!;
  }
}
