// hw-14, п.3 — воркер-пул через FOR UPDATE SKIP LOCKED: кожен воркер бере
// ОДНУ вільну задачу з job_queue, тримає лок на неї до кінця обробки (COMMIT
// разом зі status='done', інакше впав воркер до COMMIT — лок зникає, задачу
// підбере інший, підказка постановки п.7), і без SKIP LOCKED конкурент не
// пропускає залоковану задачу, а БЛОКУЄТЬСЯ і чекає на неї.
import { DataSource } from 'typeorm';

export type ClaimResult = 'done' | 'empty';

export async function claimOne(
  dataSource: DataSource,
  worker: string,
  workMs: number,
): Promise<ClaimResult> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    const rows: Array<{ id: string }> = await qr.query(
      `SELECT id FROM job_queue WHERE status = 'new'
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length === 0) {
      await qr.commitTransaction();
      return 'empty';
    }
    const id = rows[0]!.id;
    await new Promise((resolve) => setTimeout(resolve, workMs)); // "обробка" — лок тримається всю транзакцію
    await qr.query(
      `UPDATE job_queue SET status = 'done', worker = $1, processed = processed + 1
       WHERE id = $2`,
      [worker, id],
    );
    await qr.commitTransaction();
    return 'done';
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}

/**
 * SKIP LOCKED із порожнім результатом означає "вільних немає ЗАРАЗ", не
 * "черга порожня" (підказка постановки п.7) — тому воркер перепитує
 * лічильник задач зі статусом 'new' і завершується лише тоді, коли він
 * справді 0, а не одразу після першого порожнього SELECT.
 */
export async function runWorker(
  dataSource: DataSource,
  worker: string,
  workMs: number,
): Promise<void> {
  for (;;) {
    const result = await claimOne(dataSource, worker, workMs);
    if (result === 'empty') {
      const rows: Array<{ n: string }> = await dataSource.query(
        `SELECT count(*) AS n FROM job_queue WHERE status = 'new'`,
      );
      if (Number(rows[0]!.n) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
