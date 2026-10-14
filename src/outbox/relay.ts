// hw-22: relay-воркер transactional outbox (polling).
//
//   BEGIN
//   SELECT … WHERE published_at IS NULL ORDER BY created_at, id
//     LIMIT N FOR UPDATE SKIP LOCKED            -- забрати пачку
//   publish кожного рядка (confirm брокера)     -- (A)
//   UPDATE outbox SET published_at = now() …    -- (B)
//   COMMIT
//
// Порядок (A) -> (B) міняти НЕ МОЖНА. Якщо спершу позначити, а потім публікувати,
// відмова publish дасть «позначили винесеним, але не віддали» — це втрата, а вона
// не лікується нічим. Навпаки (як тут) падіння між (A) і (B) дає дубль, а дубль
// лікується дедуплікацією на консюмері. Вибір не «добре/погано», а «дубль/втрата».
//
// Помилка publish НЕ означає, що повідомлення не доставлено (загубитись могла
// відповідь брокера), тому «зловив помилку -> ROLLBACK -> усе чисто» не працює —
// ось чому ідемпотентний консюмер обовʼязковий незалежно від акуратності relay.
//
// SKIP LOCKED (а не голий FOR UPDATE): паралельні relay беруть різні рядки замість
// того, щоб стояти в черзі на одному локу. ORDER BY задає лише порядок ВИБІРКИ —
// порядок ДОСТАВКИ жоден relay не гарантує; він існує лише в межах ключа
// партиціонування (aggregate_id), і споживач на нього не покладається.
//
// Чому published_at IS NULL, а не курсор по id: bigserial видає номер на nextval,
// а видимим рядок стає на COMMIT — «взяти id > останнього обробленого» пропускає
// рядки довгих транзакцій.
import { DataSource } from 'typeorm';
import type { EventPublisher } from '../messaging/publisher';

export interface RelayHooks {
  /** Лише для demo:crash-relay: точка РІВНО між publish і UPDATE published_at. */
  afterPublish?(row: OutboxRow): void | Promise<void>;
}

export interface OutboxRow {
  id: string;
  type: string;
  payload: { eventId: string };
}

export interface RelayPass {
  claimed: number;
  published: number;
  /** Перша помилка publish у пачці; решту пачки не чіпаємо (рядки лишаються NULL). */
  error?: unknown;
}

export async function relayOnce(
  ds: DataSource,
  publisher: Pick<EventPublisher, 'publishRaw'>,
  opts: { batchSize?: number; hooks?: RelayHooks } = {},
): Promise<RelayPass> {
  const { batchSize = 50, hooks = {} } = opts;
  // Транзакція живе на ОДНОМУ клієнті пулу (QueryRunner), а не pool.query('BEGIN').
  const qr = ds.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    const rows: OutboxRow[] = await qr.query(
      `SELECT id, type, payload
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    const done: string[] = [];
    let failedId: string | undefined;
    let error: unknown;
    for (const row of rows) {
      try {
        await publisher.publishRaw(row.type, Buffer.from(JSON.stringify(row.payload)), {
          // eventId стабільний -> повторна публікація має той самий messageId
          messageId: row.payload.eventId,
          type: row.type,
          throwIfUnroutable: true,
        });
      } catch (e) {
        failedId = row.id;
        error = e;
        break;
      }
      done.push(row.id);
      await hooks.afterPublish?.(row); // <- сюди прилітає kill -9 у demo:crash-relay
    }

    if (done.length > 0) {
      await qr.query(
        `UPDATE outbox SET published_at = now(), attempts = attempts + 1
         WHERE id = ANY($1::uuid[])`,
        [done],
      );
    }
    if (failedId !== undefined) {
      await qr.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`, [failedId]);
    }
    await qr.commitTransaction();
    return { claimed: rows.length, published: done.length, error };
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}

/** Крутить relayOnce, доки є що виносити (для демо та одноразових прогонів). */
export async function relayUntilEmpty(
  ds: DataSource,
  publisher: Pick<EventPublisher, 'publishRaw'>,
  opts: { batchSize?: number; hooks?: RelayHooks } = {},
): Promise<number> {
  let total = 0;
  for (;;) {
    const pass = await relayOnce(ds, publisher, opts);
    if (pass.error) throw pass.error;
    total += pass.published;
    if (pass.claimed === 0) return total;
  }
}

export interface RunningRelay {
  stop(): Promise<void>;
}

/** Фоновий polling-цикл. Помилка брокера не вбиває цикл: рядки лишаються NULL і підуть наступним тиком. */
export function startRelay(
  ds: DataSource,
  publisher: Pick<EventPublisher, 'publishRaw'>,
  opts: { intervalMs?: number; batchSize?: number } = {},
): RunningRelay {
  const { intervalMs = 100, batchSize } = opts;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      let idle = true;
      try {
        const pass = await relayOnce(ds, publisher, { batchSize });
        idle = pass.claimed === 0 || pass.error !== undefined;
        if (pass.error) console.error('relay: publish не вдався, повторимо:', pass.error);
      } catch (e) {
        console.error('relay: прохід впав, повторимо:', e);
      }
      if (idle) await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}
