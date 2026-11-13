// HTTP-сервер спостережуваності: `node:http` без фреймворка (як service/ у hw-28) — три шари
// (controller → service → repository), RED-мідлвар, /metrics і /health. НЕ Nest-моноліт: той тягне Postgres, Redis,
// RabbitMQ, S3 і JWT-ключі, а ДЗ вимагає, щоб усе піднімалось локально разом зі стендом.
import * as http from 'node:http';
import { trace } from '@opentelemetry/api';
import { runWithContext } from './context';
import { layerLogger } from './logger';
import { ROUTE_UNMATCHED, metrics, observeRequest } from './metrics';
import {
  HttpError,
  type Reply,
  getOrderById,
  logFailure,
  postLogin,
  postOrder,
  problemBody,
} from './orders/controller';

const log = layerLogger('http.edge');

interface Route {
  method: string;
  // ШАБЛОН маршруту: саме він іде в лейбл `route`.
  template: string;
  regex: RegExp;
  handler: (req: http.IncomingMessage, params: string[]) => Promise<Reply>;
}

function route(method: string, template: string, handler: Route['handler']): Route {
  const pattern = template.replace(/:[a-zA-Z_]+/g, '([^/]+)');
  return { method, template, regex: new RegExp(`^${pattern}$`), handler };
}

const routes: Route[] = [
  route('POST', '/orders', (req) => postOrder(req)),
  route('GET', '/orders/:id', (req, p) => getOrderById(req, decodeURIComponent(p[0]))),
  route('POST', '/auth/login', (req) => postLogin(req)),
];

export function matchRoute(method: string, path: string): { route: Route; params: string[] } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(path);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    // trace_id у відповіді: клієнт називає його в тікеті — і запит знайдено.
    ...(trace.getActiveSpan() ? { 'x-trace-id': trace.getActiveSpan()!.spanContext().traceId } : {}),
  });
  res.end(payload);
}

export function createObsServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    // Службові маршрути — поза RED і поза трейсами (див. ignoreIncomingRequestHook): інакше скрейпи
    // Prometheus кожні 2 с рахувались би як трафік.
    if (method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(await metrics.registry.metrics());
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      send(res, 200, { status: 'ok', uptime_seconds: Math.round(process.uptime()), pid: process.pid });
      return;
    }

    const matched = matchRoute(method, url.pathname);
    // 🔴 Шаблон, а не сирий шлях; невідомий шлях — одна константа. Множина значень лейбла обмежена.
    const routeLabel = matched?.route.template ?? ROUTE_UNMATCHED;
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      observeRequest(method, routeLabel, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    });

    // ALS ставиться рівно один раз, на вході, і далі не передається НІКУДИ. userId у цьому зрізі — заголовок
    // `x-user-id` (у Nest-частині його ставить AuthGuard зі `sub` перевіреного токена — ДЗ #24).
    await runWithContext(
      {
        userId: header(req, 'x-user-id'),
        tenant: header(req, 'x-tenant-id'),
        idempotencyKey: header(req, 'idempotency-key'),
      },
      async () => {
        try {
          if (!matched) throw new HttpError(404, 'not-found', 'маршруту немає');
          const reply = await matched.route.handler(req, matched.params);
          log.info({ status: reply.status, route: routeLabel }, 'відповідь віддана');
          send(res, reply.status, reply.body);
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          const code = err instanceof HttpError ? err.code : 'internal';
          logFailure(err, status);
          // 5xx: тіло відповіді не розкриває причину (вона в логу за trace_id).
          const detail = status >= 500 ? 'внутрішня помилка' : (err as Error).message;
          send(res, status, problemBody(status, code, detail), 'application/problem+json');
        }
      },
    );
  });
}

export function listen(server: http.Server, port: number, host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
