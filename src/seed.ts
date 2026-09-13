// Детермінований ідемпотентний seed: 6 users, 6 products, 8 orders,
// 12 order_items. Другий запуск нічого не дублює й не падає.
//
//   users/products — мають природний унікальний ключ (email/sku) ->
//     upsert() = INSERT ... ON CONFLICT DO UPDATE, ідемпотентність з коробки.
//   orders/order_items — за дизайном hw-12 природного унікального ключа
//     не мають (це журнал подій, не довідник). Ідемпотентність тут — через
//     find-or-create по точному збігу детермінованих полів (buyer + дата
//     замовлення фіксовані, а не now()), так другий прогін знаходить те
//     саме замовлення, а не вставляє нове.
import 'reflect-metadata';
import AppDataSource from './data-source';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';

const USERS: Array<Pick<User, 'email' | 'fullName'>> = [
  { email: 'anna@example.com', fullName: 'Анна Коваль' },
  { email: 'bogdan@example.com', fullName: 'Богдан Ткаченко' },
  { email: 'iryna@example.com', fullName: 'Ірина Мельник' },
  { email: 'petro@example.com', fullName: 'Петро Бондар' },
  { email: 'olena@example.com', fullName: 'Олена Шевченко' },
  { email: 'mykola@example.com', fullName: 'Микола Іванов' },
];

const PRODUCTS: Array<Pick<Product, 'sku' | 'name' | 'price' | 'isActive'>> = [
  { sku: 'SKU-001', name: 'Клавіатура механічна', price: 1200, isActive: true },
  { sku: 'SKU-002', name: 'Миша бездротова', price: 450, isActive: true },
  { sku: 'SKU-003', name: 'Монітор 27"', price: 7800, isActive: true },
  { sku: 'SKU-004', name: 'Ноутбук 14"', price: 42000, isActive: true },
  { sku: 'SKU-005', name: 'Хаб USB-C', price: 890, isActive: true },
  { sku: 'SKU-006', name: 'Навушники', price: 1500, isActive: false },
];

interface SeedOrderItem {
  sku: string;
  quantity: number;
}

interface SeedOrder {
  buyerEmail: string;
  status: OrderStatus;
  daysOffset: number;
  items: SeedOrderItem[];
}

// createdAt = BASE_DATE + daysOffset — фіксована дата, НЕ now(): це і робить
// seed детермінованим і дає ідемпотентності природний ключ пошуку (buyer + createdAt).
const BASE_DATE = new Date('2025-01-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const ORDERS: SeedOrder[] = [
  { buyerEmail: 'anna@example.com', status: 'paid', daysOffset: 0, items: [{ sku: 'SKU-001', quantity: 1 }, { sku: 'SKU-002', quantity: 2 }] },
  { buyerEmail: 'bogdan@example.com', status: 'pending', daysOffset: 1, items: [{ sku: 'SKU-003', quantity: 1 }] },
  { buyerEmail: 'iryna@example.com', status: 'shipped', daysOffset: 2, items: [{ sku: 'SKU-004', quantity: 1 }, { sku: 'SKU-005', quantity: 3 }] },
  { buyerEmail: 'petro@example.com', status: 'cancelled', daysOffset: 3, items: [{ sku: 'SKU-006', quantity: 2 }] },
  { buyerEmail: 'olena@example.com', status: 'refunded', daysOffset: 4, items: [{ sku: 'SKU-001', quantity: 2 }] },
  { buyerEmail: 'mykola@example.com', status: 'paid', daysOffset: 5, items: [{ sku: 'SKU-002', quantity: 1 }, { sku: 'SKU-004', quantity: 1 }] },
  { buyerEmail: 'anna@example.com', status: 'shipped', daysOffset: 6, items: [{ sku: 'SKU-005', quantity: 1 }] },
  { buyerEmail: 'bogdan@example.com', status: 'pending', daysOffset: 7, items: [{ sku: 'SKU-003', quantity: 2 }, { sku: 'SKU-006', quantity: 1 }] },
];

async function main() {
  await AppDataSource.initialize();

  const userRepo = AppDataSource.getRepository(User);
  const productRepo = AppDataSource.getRepository(Product);
  const orderRepo = AppDataSource.getRepository(Order);
  const itemRepo = AppDataSource.getRepository(OrderItem);

  await userRepo.upsert(USERS.map((u) => ({ ...u })), ['email']);
  await productRepo.upsert(PRODUCTS.map((p) => ({ ...p })), ['sku']);

  const userByEmail = new Map(
    (await userRepo.find()).map((u) => [u.email, u] as const),
  );
  const productBySku = new Map(
    (await productRepo.find()).map((p) => [p.sku, p] as const),
  );

  let insertedOrders = 0;
  let insertedItems = 0;

  for (const seedOrder of ORDERS) {
    const buyer = userByEmail.get(seedOrder.buyerEmail);
    if (!buyer) throw new Error(`Невідомий покупець у seed: ${seedOrder.buyerEmail}`);

    const createdAt = new Date(BASE_DATE.getTime() + seedOrder.daysOffset * DAY_MS);

    const lines = seedOrder.items.map(({ sku, quantity }) => {
      const product = productBySku.get(sku);
      if (!product) throw new Error(`Невідомий товар у seed: ${sku}`);
      return { product, quantity, unitPrice: product.price };
    });
    const totalAmount = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

    let order = await orderRepo.findOne({
      where: { buyer: { id: buyer.id }, createdAt },
    });
    if (!order) {
      order = await orderRepo.save(
        orderRepo.create({
          buyer,
          customerEmail: buyer.email,
          status: seedOrder.status,
          totalAmount,
          createdAt,
        }),
      );
      insertedOrders += 1;
    }

    for (const { product, quantity, unitPrice } of lines) {
      const exists = await itemRepo.findOne({
        where: {
          order: { id: order.id },
          product: { id: product.id },
          quantity,
          unitPrice,
        },
      });
      if (!exists) {
        await itemRepo.save(itemRepo.create({ order, product, quantity, unitPrice }));
        insertedItems += 1;
      }
    }
  }

  console.log(
    [
      `users: ${userByEmail.size}`,
      `products: ${productBySku.size}`,
      `orders: +${insertedOrders} нових (усього ${await orderRepo.count()})`,
      `order_items: +${insertedItems} нових (усього ${await itemRepo.count()})`,
    ].join(', '),
  );

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
