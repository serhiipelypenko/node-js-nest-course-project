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
// Порядок локів у транзакції ЗАВЖДИ products -> users -> orders ->
// order_items -> job_queue — однаковий у кожному викликові checkout(), тому
// дві конкурентні транзакції-чекаути ніколи не можуть чекати одна на одну
// в протилежному порядку (передумова deadlock 40P01, лекція 14 крок 5).
import { DataSource } from 'typeorm';

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
}

export interface CheckoutSuccess {
  ok: true;
  orderId: string;
  totalAmount: number;
}

export interface CheckoutFailure {
  ok: false;
  reason: CheckoutFailureReason;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

export async function checkout(
  dataSource: DataSource,
  { buyerId, productId, quantity }: CheckoutParams,
): Promise<CheckoutResult> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction(); // READ COMMITTED (дефолт) — достатньо: атомарність дає сам UPDATE, не рівень ізоляції
  try {
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

    await qr.commitTransaction();
    return { ok: true, orderId, totalAmount };
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}
