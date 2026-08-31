import { Injectable, NotFoundException } from '@nestjs/common';
import { Page, paginate } from '../common/cursor';

export interface Product {
  id: string;
  name: string;
  price_cents: number;
}

const PRODUCTS: Product[] = [
  { id: 'p1', name: 'Клавіатура механічна', price_cents: 129900 },
  { id: 'p2', name: 'Мишка бездротова', price_cents: 45900 },
  { id: 'p3', name: 'Килимок для миші', price_cents: 12900 },
  { id: 'p4', name: 'Монітор 27"', price_cents: 899900 },
  { id: 'p5', name: 'Навушники', price_cents: 219900 },
];

@Injectable()
export class ProductsService {
  list(limit: number, cursor?: string): Page<Product> {
    return paginate(PRODUCTS, limit, cursor);
  }

  getById(id: string): Product {
    const product = PRODUCTS.find((p) => p.id === id);
    if (!product) {
      throw new NotFoundException({ detail: `товар "${id}" не знайдено` });
    }
    return product;
  }

  findByIds(ids: string[]): Product[] {
    return PRODUCTS.filter((p) => ids.includes(p.id));
  }
}
