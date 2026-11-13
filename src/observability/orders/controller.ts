// Шар контролера — єдине місце, яке бачить `req`. Нижче (service/repository) його немає.
import type { IncomingMessage } from 'node:http';
import { trace } from '@opentelemetry/api';
import { layerLogger } from '../logger';
import { createOrder, getOrder } from './service';

const log = layerLogger('orders.controller');

export interface Reply {
  status: number;
  body: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Тіло читаємо з ліміту: не даємо розпухнути памʼяті на нескінченному POST.
const MAX_BODY = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new HttpError(413, 'body-too-large', 'тіло завелике');
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad-json', 'тіло не є JSON-обʼєктом');
  }
}

// Один рядок «запит прийнято» на вході. Свідомо кладемо в нього і заголовки, і тіло: redact — остання лінія
// оборони, і саме її перевіряє demo:logs (Authorization, password).
function logRequest(req: IncomingMessage, body: Record<string, unknown>): void {
  log.info({ req: { method: req.method, url: req.url, headers: req.headers }, body }, 'запит прийнято');
}

export async function postOrder(req: IncomingMessage): Promise<Reply> {
  const body = await readJson(req);
  logRequest(req, body);
  // Idempotency-Key (ДЗ #22) обовʼязковий на створенні; сам він уже в ALS і в кожному рядку логу.
  if (!req.headers['idempotency-key']) {
    throw new HttpError(400, 'idempotency-key-required', 'потрібен заголовок Idempotency-Key');
  }
  const sku = body.sku;
  const qty = body.qty;
  if (typeof sku !== 'string' || !sku || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
    throw new HttpError(400, 'bad-order', 'потрібні sku (рядок) і qty (ціле ≥ 1)');
  }
  const order = await createOrder({ sku, qty });
  return { status: 201, body: order };
}

export async function getOrderById(req: IncomingMessage, id: string): Promise<Reply> {
  logRequest(req, {});
  const order = await getOrder(id);
  return { status: 200, body: order };
}

// Заглушка входу з ДЗ #24: справжній /auth/login живе в Nest-частині, тут важливе лише одне — тіло з паролем
// і Authorization-заголовок проходять через логер, а redact їх ховає.
export async function postLogin(req: IncomingMessage): Promise<Reply> {
  const body = await readJson(req);
  logRequest(req, body);
  return { status: 200, body: { status: 'accepted' } };
}

// RFC 9457 problem+json — єдиний формат помилки (як у Nest-частині); `trace_id` — розширення, за яким
// підтримка знаходить запит у логах і трейсах за хвилину.
export function problemBody(status: number, code: string, detail: string): Record<string, unknown> {
  return {
    type: `https://marketplace.example/problems/${code}`,
    title: code,
    status,
    detail,
    trace_id: trace.getActiveSpan()?.spanContext().traceId,
  };
}

export function logFailure(err: unknown, status: number): void {
  const level = status >= 500 ? 'error' : 'warn';
  log[level]({ err, status }, 'запит завершився помилкою');
}
