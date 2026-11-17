// Контекст запиту живе ТУТ (AsyncLocalStorage), а не в аргументах функцій: жоден шар нижче
// контролера не приймає `req` — і все одно його логи знають userId/tenant/idempotencyKey.
//
// Корелятор ТУТ НЕ ЗБЕРІГАЄТЬСЯ: trace_id береться з активного спана OpenTelemetry (див. logger.ts).
// Власний uuid у ALS дав би два ключі замість одного — і trace-matches-log ніколи б не зійшовся.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userId?: string; // ДЗ #24: sub токена (після AuthGuard)
  tenant?: string;
  idempotencyKey?: string; // ДЗ #22: заголовок Idempotency-Key
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

// Дописати поле в ПОТОЧНИЙ контекст (наприклад, userId — після того як гард його знає).
export function enrichContext(patch: Partial<RequestContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}
