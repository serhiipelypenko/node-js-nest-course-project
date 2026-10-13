// hw-14, п.1 — транзакційний checkout: decrement stock + списання балансу
// покупця + INSERT замовлення + INSERT задачі на post-processing, усе в
// ОДНІЙ транзакції на ОДНОМУ клієнті пулу (QueryRunner тримає власне
// з'єднання від BEGIN до COMMIT/ROLLBACK — const c = await pool.connect(),
// не pool.query('BEGIN'), інакше BEGIN і COMMIT поїдуть у різні з'єднання).
//
// Захист від oversell/овердрафту — атомарний
//   UPDATE ... SET x = x - $n WHERE ... AND x >= $n RETURNING
// а НЕ SELECT ... FOR UPDATE. Обґрунтування — README, розділ
// «Конкурентність»: перевірка достатності і лок на рядок — той самий
// SQL-statement, тому немислиме вікно між "прочитав" і "списав", а сам
// UPDATE не тримає лок довше одного round-trip (на відміну від
// FOR UPDATE, де лок живе, доки транзакція явно його не відпустить).
//
// Порядок локів у транзакції ЗАВЖДИ idempotency_keys -> products -> users ->
// orders -> order_items -> job_queue -> outbox — однаковий у кожному викликові checkout(), тому
// дві конкурентні транзакції-чекаути ніколи не можуть чекати одна на одну
// в протилежному порядку (передумова deadlock 40P01, лекція 14 крок 5).
import { DataSource } from 'typeorm';
import { toOrderPlacedEvent } from './messaging/events';

// hw-22: checkout НІЧОГО не публікує в брокер. Подія лягає в таблицю outbox тієї
// самої бази, тією самою транзакцією, що й замовлення: COMMIT один, менеджер
// ресурсів один. Винос назовні — окремий процес (src/outbox/relay.ts).
// (hw-19 публікував після COMMIT: падіння між COMMIT і confirm губило подію.)

// Точка впровадження збою для demo:crash-write — єдине місце, де демо може
// вбити транзакцію РІВНО після INSERT в outbox, але до COMMIT. У проді не
// передається.
export interface CheckoutHooks {
  afterOutboxInsert?(): void | Promise<void>;
}

//  TypeORM/pg: для
// UPDATE ... RETURNING queryRunner.query() повертає tuple [rows, rowCount],
// а НЕ просто rows, як для SELECT і навіть для INSERT ... RETURNING
// Перевірка
// `result.length === 0` без unwrapReturning мовчки завжди хибна (довжина
// tuple — 2), тобто перший атомарний UPDATE "успішний" навіть коли він не
// торкнувся жодного рядка — рівно той oversell, від якого захищає п.1.
function unwrapReturning<T>(result: unknown): T[] {
  return Array.isArray(result) && result.length === 2 && Array.isArray(result[0])
    ? (result[0] as T[])
    : (result as T[]);
}

export type CheckoutFailureReason = 'out_of_stock' | 'insufficient_funds';

export interface CheckoutParams {
  buyerId: string;
  productId: string;
  quantity: number;
  // hw-22, рівень 3: ключ ідентифікує НАМІР клієнта (одна спроба «купити»), а не
  // байти тіла. Хеш тіла схлопнув би два легітимні однакові замовлення в одне.
  idempotencyKey?: string;
}

export interface CheckoutSuccess {
  ok: true;
  orderId: string;
  totalAmount: number;
  // true — це повтор запиту з уже відомим ключем: нове замовлення і нова подія
  // НЕ створювались, повернуто результат першої спроби.
  replayed: boolean;
}

export interface CheckoutFailure {
  ok: false;
  reason: CheckoutFailureReason;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

export async function checkout(
  dataSource: DataSource,
  { buyerId, productId, quantity, idempotencyKey }: CheckoutParams,
  hooks: CheckoutHooks = {},
): Promise<CheckoutResult> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction(); // READ COMMITTED (дефолт) — достатньо: атомарність дає сам UPDATE, не рівень ізоляції
  try {
    // 0) ключ ідемпотентності — ПЕРШИМ і в цій самій транзакції. Рядок ключа
    // з'являється лише разом із замовленням (один COMMIT), а відкат checkout
    // (out_of_stock) звільняє ключ для повторної спроби. Паралельний дубль
    // блокується на унікальному індексі до COMMIT/ROLLBACK першого — тому
    // після розблокування бачить уже ЗАКОМІЧЕНИЙ результат, а не зайве списання.
    if (idempotencyKey !== undefined) {
      const claimed: Array<{ key: string }> = await qr.query(
        `INSERT INTO idempotency_keys (key) VALUES ($1)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey],
      );
      if (claimed.length === 0) {
        const prev: Array<{ id: string; total_amount: string }> = await qr.query(
          `SELECT o.id, o.total_amount
           FROM idempotency_keys k JOIN orders o ON o.id = k.order_id
           WHERE k.key = $1`,
          [idempotencyKey],
        );
        await qr.rollbackTransaction(); // нічого не писали
        return {
          ok: true,
          orderId: prev[0]!.id,
          totalAmount: Number(prev[0]!.total_amount),
          replayed: true,
        };
      }
    }

    // 1) склад: атомарний декремент з перевіркою достатності в тому самому statement
    const stockRows = unwrapReturning<{ price: string }>(
      await qr.query(
        `UPDATE products SET stock = stock - $1
         WHERE id = $2 AND stock >= $1
         RETURNING price`,
        [quantity, productId],
      ),
    );
    if (stockRows.length === 0) {
      await qr.rollbackTransaction();
      return { ok: false, reason: 'out_of_stock' };
    }
    const unitPrice = Number(stockRows[0].price);
    const totalAmount = unitPrice * quantity;

    // 2) баланс покупця: та сама атомарна форма
    const balanceRows = unwrapReturning<{ balance: string }>(
      await qr.query(
        `UPDATE users SET balance = balance - $1
         WHERE id = $2 AND balance >= $1
         RETURNING balance`,
        [totalAmount, buyerId],
      ),
    );
    if (balanceRows.length === 0) {
      await qr.rollbackTransaction();
      return { ok: false, reason: 'insufficient_funds' };
    }

    const buyerRows: Array<{ email: string }> = await qr.query(
      `SELECT email FROM users WHERE id = $1`,
      [buyerId],
    );
    const customerEmail = buyerRows[0]?.email ?? '';

    // 3) замовлення + позиція — товар і кошти вже списані вище в цій самій транзакції
    const orderRows: Array<{ id: string }> = await qr.query(
      `INSERT INTO orders (buyer_id, customer_email, status, total_amount)
       VALUES ($1, $2, 'paid', $3)
       RETURNING id`,
      [buyerId, customerEmail, totalAmount],
    );
    const orderId = orderRows[0]!.id;

    await qr.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4)`,
      [orderId, productId, quantity, unitPrice],
    );

    // 4) задача на post-processing (лист/чек) — у ЦІЙ ЖЕ транзакції: якщо
    // checkout відкотиться, "сирітської" задачі без замовлення не буде;
    // саму задачу обробляє окремо воркер-пул (queue-worker.ts, п.3).
    await qr.query(
      `INSERT INTO job_queue (order_id, kind) VALUES ($1, 'post_processing')`,
      [orderId],
    );

    if (idempotencyKey !== undefined) {
      await qr.query(`UPDATE idempotency_keys SET order_id = $1 WHERE key = $2`, [
        orderId,
        idempotencyKey,
      ]);
    }

    // 5) hw-22: подія в outbox — ТІЄЮ САМОЮ транзакцією. Контракт будується
    // явною функцією, а не spread-ом рядка orders (схема БД ≠ публічний API).
    // Жодного publish до COMMIT: брокер не вміє відкочуватись.
    const event = toOrderPlacedEvent({
      id: orderId,
      buyerId,
      productId,
      quantity,
      totalAmount,
      placedAt: new Date(),
    });
    await qr.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, type, payload)
       VALUES ('Order', $1, $2, $3::jsonb)`,
      [orderId, event.type, JSON.stringify(event)],
    );

    await hooks.afterOutboxInsert?.();

    await qr.commitTransaction();
    return { ok: true, orderId, totalAmount, replayed: false };
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}
