// RED у prom-client: Rate + Errors — лічильник запитів, Duration — гістограма. Модель PULL: застосунок нічого
// нікуди не шле, Prometheus приходить на /metrics.
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// 🔴 Бакети — це і є роздільність майбутнього перцентиля. Верхній СКІНЧЕННИЙ le (5 с) більший за найгірший
// випадок сервісу (дедлайн репозиторію 2 с, див. orders/repository.ts): інакше histogram_quantile упирається
// в межу й малює здорову лінію саме тоді, коли все погано. Частина запитів «за верхнім бакетом» = _count − _bucket{le=<top>}.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
export const TOP_FINITE_BUCKET = DURATION_BUCKETS[DURATION_BUCKETS.length - 1];

// 🔴 route — ШАБЛОН (`/orders/:id`), а не сирий шлях. Сирий шлях = лейбл із вільним значенням = новий ряд
// на кожен id (кардинальність росте множником). Невідомий шлях зводиться до однієї константи.
export const ROUTE_UNMATCHED = 'unmatched';

export interface Metrics {
  registry: Registry;
  requests: Counter<'method' | 'route' | 'status'>;
  duration: Histogram<'method' | 'route' | 'status'>;
}

export function createMetrics(withDefaults = false): Metrics {
  const registry = new Registry();
  if (withDefaults) collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Скільки запитів обслужено (R і E у RED; E = status=~"5..")',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  // Histogram, а не Summary: квантилі Summary рахуються на боці застосунку і не агрегуються між інстансами.
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Тривалість запиту, секунди (D у RED)',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  return { registry, requests, duration };
}

// Один спільний реєстр процесу. Демо скидає його на старті (reset()), а не створює новий:
// так /metrics сервера й демо дивляться в одне й те саме.
export const metrics = createMetrics();

export function observeRequest(method: string, route: string, statusCode: number, seconds: number): void {
  // status — HTTP-код ("201", "500"), не "ok"/"error": інакше `status=~"5.."` нічого не знайде.
  const labels = { method, route, status: String(statusCode) };
  metrics.requests.inc(labels);
  metrics.duration.observe(labels, seconds);
}

export function resetMetrics(): void {
  metrics.registry.resetMetrics();
}
