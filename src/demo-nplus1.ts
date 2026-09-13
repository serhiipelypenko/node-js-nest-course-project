// N+1 "до/після" на графі order -> items -> product (2 рівні зв'язків).
//
// Демо навмисно НЕ залежить від npm run seed: створює власний одноразовий
// набір даних у транзакції, яку в кінці відкочує (rollback) — тому запуск
// не забруднює базу і не залежить від того, чи вже накотили seed.ts.
//
// Кожен вимір робиться на ДВОХ розмірах колекції (N=5 і N=40), щоб довести
// ключову властивість фіксів: кількість запитів "після" НЕ росте разом з N.
import 'reflect-metadata';
import { DataSource, EntityManager, In } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';
import { QueryCountLogger } from './query-count-logger';

const logger = new QueryCountLogger(['query']);
// Окремий DataSource, не той, що йде в CLI (dist/data-source.js): CLI-шлях
// має лишитись "чистим" (без лічильника запитів), а тут він потрібен.
const ds = new DataSource({ ...dataSourceOptions, logger });

async function makeDataset(manager: EntityManager, ordersCount: number, tag: string) {
  const buyer = await manager.save(User, {
    email: `nplus1-${tag}-${Date.now()}@example.com`,
    fullName: `Demo Buyer ${tag}`,
  });
  const product = await manager.save(Product, {
    sku: `NPLUS1-${tag}-${Date.now()}`,
    name: `Demo product ${tag}`,
    price: 10,
    isActive: true,
  });

  const orderIds: string[] = [];
  for (let i = 0; i < ordersCount; i++) {
    const order = await manager.save(Order, {
      buyer,
      customerEmail: buyer.email,
      status: 'paid',
      totalAmount: 10,
      createdAt: new Date(),
    });
    await manager.save(OrderItem, { order, product, quantity: 1, unitPrice: 10 });
    orderIds.push(order.id);
  }
  return orderIds;
}

async function measureNaive(manager: EntityManager, orderIds: string[]): Promise<number> {
  logger.reset();
  const orderRepo = manager.getRepository(Order);
  const itemRepo = manager.getRepository(OrderItem);
  const productRepo = manager.getRepository(Product);

  const orders = await orderRepo.findBy({ id: In(orderIds) }); // SQL#1
  for (const order of orders) {
    const items = await itemRepo.findBy({ order: { id: order.id } }); // SQL у циклі, по одному на order
    for (const item of items) {
      await productRepo.findOneBy({ id: item.productId }); // ще SQL у циклі, по одному на item
    }
  }
  return logger.count;
}

async function measureRelations(manager: EntityManager, orderIds: string[]): Promise<number> {
  logger.reset();
  await manager.getRepository(Order).find({
    where: { id: In(orderIds) },
    relations: { items: { product: true } },
  });
  return logger.count;
}

async function measureQueryStrategy(manager: EntityManager, orderIds: string[]): Promise<number> {
  logger.reset();
  await manager.getRepository(Order).find({
    where: { id: In(orderIds) },
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });
  return logger.count;
}

async function main() {
  await ds.initialize();

  const qr = ds.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  try {
    console.log('Готую два одноразові набори даних (N=5 та N=40, у транзакції)…\n');
    const small = await makeDataset(qr.manager, 5, 'small');
    const big = await makeDataset(qr.manager, 40, 'big');

    console.log('── Наївно: find() списку + запит на кожен order, і ще один на кожен item ──');
    const naiveSmall = await measureNaive(qr.manager, small);
    const naiveBig = await measureNaive(qr.manager, big);
    console.log(`  N=5:  ${naiveSmall} запитів`);
    console.log(`  N=40: ${naiveBig} запитів   (росте разом з N — ось і N+1)\n`);

    console.log('── Фікс: relations: { items: { product: true } } (LEFT JOIN) ──');
    const relSmall = await measureRelations(qr.manager, small);
    const relBig = await measureRelations(qr.manager, big);
    console.log(`  N=5:  ${relSmall} запит(ів)`);
    console.log(`  N=40: ${relBig} запит(ів)   (константа, не залежить від N)\n`);

    console.log("── relationLoadStrategy: 'query' (без JOIN, батчами по IN) ──");
    const qsSmall = await measureQueryStrategy(qr.manager, small);
    const qsBig = await measureQueryStrategy(qr.manager, big);
    console.log(`  N=5:  ${qsSmall} запит(ів)`);
    console.log(`  N=40: ${qsBig} запит(ів)   (теж константа — 2 рівні зв'язків)\n`);

    console.log(
      `Підсумок: наївно ${naiveSmall} -> ${naiveBig} (росте з N); ` +
        `relations ${relSmall}/${relBig} і query-стратегія ${qsSmall}/${qsBig} — обидва незмінні при рості N.`,
    );
  } finally {
    await qr.rollbackTransaction();
    await qr.release();
  }

  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
