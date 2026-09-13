// hw-14, п.4 — npm run demo:retry: сценарій, що провокує serialization
// failure (два конкурентні read-modify-write під REPEATABLE READ), і
// withRetry (concurrency/lib.ts), що ловить ЛИШЕ 40001/40P01, повторює
// транзакцію ЦІЛКОМ (включно з читанням — повтор тільки запису лишився б
// lost update, підказка постановки п.7) із backoff і логує кожен повтор.
//
// Це НЕ checkout(): checkout() навмисно атомарний (UPDATE ... RETURNING,
// без читання в застосунок), тому під REPEATABLE READ у нього просто немає
// вікна для 40001. Тут навпаки — навмисний read-modify-write (SELECT
// balance, "думаємо", UPDATE new_balance)
import 'reflect-metadata';
import { createDataSource, hdr, log, note, sleep, withRetry } from './concurrency/lib';

const START_BALANCE = 100;

async function main(): Promise<void> {
  hdr('hw-14 · demo:retry — 40001 під REPEATABLE READ + withRetry');
  const ds = createDataSource(10);
  await ds.initialize();

  const [buyer]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, full_name, balance)
     VALUES ('retry-demo@example.com', 'Покупець демо-retry', $1)
     ON CONFLICT (email) DO UPDATE SET balance = $1
     RETURNING id`,
    [START_BALANCE],
  );
  const buyerId = buyer.id;

  note(`старт: balance = ${START_BALANCE}. A додає +50 (думає 100 мс), B знімає -30 (думає 200 мс, старт на 50 мс пізніше).`);
  note('обидва — read-modify-write (SELECT -> "думаємо" -> UPDATE), той самий read-modify-write, що lost update без транзакцій.');

  const adjust = (tag: string, delta: number, thinkMs: number) =>
    withRetry(tag, ds, async (qr) => {
      const rows: Array<{ balance: string }> = await qr.query(
        `SELECT balance FROM users WHERE id = $1`,
        [buyerId],
      );
      const seen = Number(rows[0]!.balance);
      log(tag, `SELECT balance -> ${seen}`);
      await sleep(thinkMs);
      const next = seen + delta;
      await qr.query(`UPDATE users SET balance = $1 WHERE id = $2`, [next, buyerId]);
      log(tag, `UPDATE balance = ${seen} + (${delta}) = ${next}`);
    });

  await Promise.all([
    adjust('A', +50, 100),
    (async () => {
      await sleep(50);
      await adjust('B', -30, 200);
    })(),
  ]);

  const [{ balance: finalRaw }]: Array<{ balance: string }> = await ds.query(
    `SELECT balance FROM users WHERE id = $1`,
    [buyerId],
  );
  const finalBalance = Number(finalRaw);
  const expected = START_BALANCE + 50 - 30;
  console.log(`фінальний balance: ${finalBalance} (очікували ${expected})`);

  await ds.destroy();

  if (finalBalance !== expected) {
    console.error('арифметика не зійшлась — lost update прослизнув повз retry');
    process.exit(1);
  }
  console.log('OK — арифметика коректна, обидва перекази виживають через retry.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
