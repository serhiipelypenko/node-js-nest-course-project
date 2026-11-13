// Шар репозиторію. Про HTTP не знає нічого: ні `req`, ні trace_id в аргументах — лише ручний спан
// навколо «запиту до бази» і рядки логу з тим самим корелятором.
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../otel';
import { layerLogger } from '../logger';

const log = layerLogger('orders.repo');

// Дедлайн операції — це й є НАЙГІРШИЙ ВИПАДОК сервісу: від нього залежить верхній бакет гістограми.
export const REPO_DEADLINE_MS = 2000;

// SKU, на якому репозиторій «падає» (демонстраційна інʼєкція збою: реальний 5xx без підміни коду відповіді).
export const FAULT_SKU = 'sku-db-locked';
// SKU, на якому запис повільний (≈ блокування рядка) — щоб гістограма бачила хвіст, а не лише швидкі запити.
export const SLOW_SKU = 'sku-slow-lock';
export const SLOW_MS = 800;

export interface OrderRecord {
  id: string;
  sku: string;
  qty: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Операція довша за дедлайн перетворюється на помилку (→ 500): саме тому найгірший випадок сервісу відомий
// і верхній бакет гістограми можна вибрати більшим за нього.
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`repo deadline ${REPO_DEADLINE_MS} ms exceeded`)), REPO_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Сховище в памʼяті (як і ресурси Nest-застосунку до цього ДЗ) — спан `db.*` лишається справжнім спаном.
const store = new Map<string, OrderRecord>();

export function resetStore(): void {
  store.clear();
}

export async function insertOrder(rec: OrderRecord): Promise<OrderRecord> {
  return tracer.startActiveSpan('orders.repo.insert', async (span) => {
    span.setAttribute('db.system', 'memory');
    span.setAttribute('db.operation', 'INSERT');
    log.info({ sql: 'INSERT INTO orders ...', sku: rec.sku }, 'запис замовлення');
    try {
      if (rec.sku === FAULT_SKU) {
        throw new Error('orders table is locked');
      }
      await withDeadline(sleep(rec.sku === SLOW_SKU ? SLOW_MS : 5 + (rec.qty % 5)));
      store.set(rec.id, rec);
      return rec;
    } catch (err) {
      // помилка ляже і в СТАТУС спана, і в подію спана — інакше трейс виглядатиме «успішним».
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function findOrder(id: string): Promise<OrderRecord> {
  return tracer.startActiveSpan('orders.repo.find', async (span) => {
    span.setAttribute('db.system', 'memory');
    span.setAttribute('db.operation', 'SELECT');
    log.info({ sql: 'SELECT * FROM orders WHERE id = $1', id }, 'читання замовлення');
    try {
      await withDeadline(sleep(3));
      // Будь-який id існує: демо стукає сотнею різних id в ОДИН маршрут, і всі відповіді мають бути однакового
      // статусу (інакше новий status = новий ряд, і це вже не про route).
      return store.get(id) ?? { id, sku: 'sku-seed', qty: 1 };
    } finally {
      span.end();
    }
  });
}
