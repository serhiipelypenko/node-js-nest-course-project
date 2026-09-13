// hw-14, п.3 — npm run demo:workers: ≥2 воркери розбирають задачі з
// job_queue через FOR UPDATE SKIP LOCKED (queue-worker.ts). Задачі — не
// синтетичні рядки, а справжні post-processing-задачі, які саме checkout()
// кладе в чергу в тій самій транзакції, що й замовлення (п.1) — так демо
// показує реальний шлях "checkout -> черга -> воркер", а не окрему вигадану
// таблицю.
import 'reflect-metadata';
import { checkout } from './checkout';
import { createDataSource, hdr, note } from './concurrency/lib';
import { runWorker } from './queue-worker';

const JOBS = 20;
const WORKERS = 4; // >= 2 з постановки
const WORK_MS = 100;

async function main(): Promise<void> {
  hdr(`hw-14 · demo:workers — ${JOBS} задач, ${WORKERS} воркери, SKIP LOCKED`);
  const ds = createDataSource(WORKERS + JOBS + 5);
  await ds.initialize();

  const [product]: Array<{ id: string }> = await ds.query(
    `INSERT INTO products (sku, name, price, stock)
     VALUES ('WORKERS-DEMO', 'Товар демо-воркерів', 10, 1000000)
     ON CONFLICT (sku) DO UPDATE SET stock = 1000000
     RETURNING id`,
  );
  const [buyer]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, full_name)
     VALUES ('workers-demo@example.com', 'Покупець демо-воркерів')
     ON CONFLICT (email) DO UPDATE SET balance = 1000000
     RETURNING id`,
  );

  // JOBS реальних чекаутів -> JOBS рядків у job_queue зі статусом 'new'
  // (кожен checkout() кладе рівно один, п.1). orderIds — щоб після прогону
  // подивитись розподіл САМЕ цих задач, а не задач з попередніх запусків
  // демо (ті вже 'done' і воркерам нижче не трапляться, але для звіту по
  // воркерах беремо точний список, а не "останню хвилину").
  const orderIds: string[] = [];
  for (let i = 0; i < JOBS; i += 1) {
    const r = await checkout(ds, { buyerId: buyer.id, productId: product.id, quantity: 1 });
    if (!r.ok) throw new Error(`неочікуваний провал checkout() при підготовці задач: ${r.reason}`);
    orderIds.push(r.orderId);
  }

  note(`ідеал (${WORKERS} воркери): ${Math.round((JOBS / WORKERS) * WORK_MS)} мс · послідовно: ${JOBS * WORK_MS} мс`);

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => `w${i + 1}`).map((w) =>
      runWorker(ds, w, WORK_MS),
    ),
  );
  const elapsed = Date.now() - t0;

  const stats: Array<{ worker: string; n: string }> = await ds.query(
    `SELECT worker, count(*) AS n FROM job_queue
     WHERE order_id = ANY($1::bigint[])
     GROUP BY worker ORDER BY worker`,
    [orderIds],
  );
  const twice: Array<{ n: string }> = await ds.query(
    `SELECT count(*) AS n FROM job_queue WHERE processed > 1`,
  );
  const processedTwice = Number(twice[0]!.n);

  console.log(`час: ${elapsed} мс`);
  console.log(`розподіл по воркерах: ${stats.map((s) => `${s.worker}=${s.n}`).join(' ')}`);
  console.log(`оброблено двічі: ${processedTwice}`);

  await ds.destroy();

  const sequential = JOBS * WORK_MS;
  if (processedTwice > 0 || elapsed >= sequential) {
    console.error(
      `провал інваріанту: оброблено двічі має бути 0 (є ${processedTwice}), час має бути < ${sequential} мс (є ${elapsed})`,
    );
    process.exit(1);
  }
  console.log('OK — кожна задача оброблена рівно один раз, час менший за послідовний.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
