// hw-22, рівень 3: Idempotency-Key на API-краю.
//
// Це окремий мінімальний HTTP-край (node:http) поверх checkout() — шлях B
// data-шару (DB_* + TypeORM). Nest-сервер зі своїм in-memory POST /orders
// (шлях A) не чіпаємо.
//
// Серверна механіка ключа — у checkout() (таблиця idempotency_keys, ключ
// «займається» ПЕРШИМ рядком тієї самої транзакції, що й замовлення + outbox).
// Тут лише протокол:
//   перший запит        -> 201 Created
//   повтор того ж ключа -> 200 OK + Idempotent-Replayed: true, те саме замовлення
//   немає заголовка     -> 400 problem+json
// Ключ ідентифікує НАМІР, а не тіло: два запити з різними ключами й однаковим
// тілом — це два легітимні замовлення.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { checkout } from '../checkout';
import { PROBLEM_BASE, PROBLEM_TITLES } from '../common/problem';

const BodySchema = z.object({
  buyer_id: z.string().min(1),
  product_id: z.string().min(1),
  quantity: z.number().int().positive(),
});

const MAX_KEY_LENGTH = 255;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, req: IncomingMessage, status: number, code: string, detail: string): void {
  send(
    res,
    status,
    {
      type: `${PROBLEM_BASE}/${code}`,
      title: PROBLEM_TITLES[status] ?? 'Помилка',
      status,
      detail,
      instance: req.url,
    },
    { 'content-type': 'application/problem+json' },
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw === '' ? undefined : JSON.parse(raw);
}

export function createOrdersApi(ds: DataSource): Server {
  return createServer((req, res) => {
    void handle(ds, req, res).catch((e) => {
      console.error('orders-api:', e);
      if (!res.headersSent) problem(res, req, 500, 'internal', 'Внутрішня помилка сервера');
    });
  });
}

async function handle(ds: DataSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/orders') {
    return problem(res, req, 404, 'not-found', 'Невідомий маршрут');
  }

  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH) {
    return problem(res, req, 400, 'idempotency-key-required', `Потрібен заголовок Idempotency-Key (1..${MAX_KEY_LENGTH} символів)`);
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await readJson(req));
  } catch {
    return problem(res, req, 422, 'invalid-body', 'Тіло має бути {buyer_id, product_id, quantity>0}');
  }

  const r = await checkout(ds, {
    buyerId: body.buyer_id,
    productId: body.product_id,
    quantity: body.quantity,
    idempotencyKey: key,
  });
  if (!r.ok) {
    return problem(res, req, 409, r.reason, r.reason === 'out_of_stock' ? 'Товару не вистачає' : 'Недостатньо коштів');
  }
  send(
    res,
    r.replayed ? 200 : 201,
    { order_id: r.orderId, total_amount: r.totalAmount },
    r.replayed ? { 'idempotent-replayed': 'true' } : {},
  );
}
