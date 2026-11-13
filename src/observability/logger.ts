// pino: кожен рядок — JSON у stdout; корелятор і поля ALS підставляє mixin, ніхто не передає їх руками.
import { trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';
import { currentContext } from './context';

// Шляхи, які redact ховає. 🔴 redact НЕ вгадує: вкладений обʼєкт без описаного шляху лишається у лозі
// (demo:logs показує це числом `unlisted-path-leak`). Тому список явний, а `*` покриває один рівень.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // тіла автентифікації з ДЗ #24: login {email,password}, refresh {refresh_token}
  'body.password',
  'body.refresh_token',
  'body.access_token',
  'body.token',
  '*.password',
  '*.refresh_token',
  '*.access_token',
  '*.token',
  'password',
  'refresh_token',
  'access_token',
  'token',
];
export const REDACT_CENSOR = '[REDACTED]';

// Приймач рядків: stdout + «підслухачі» (їх ставлять демо, щоб ПОРАХУВАТИ рядки, а не вірити на слово).
type Tap = (line: string) => void;
const taps = new Set<Tap>();
let stdoutEnabled = true;

const destination = {
  write(chunk: string): void {
    if (stdoutEnabled) process.stdout.write(chunk);
    for (const line of chunk.split('\n')) {
      if (line) for (const tap of taps) tap(line);
    }
  },
};

export function addLogTap(tap: Tap): () => void {
  taps.add(tap);
  return () => taps.delete(tap);
}

export function setStdoutLogging(enabled: boolean): void {
  stdoutEnabled = enabled;
}

export const rootLogger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.OTEL_SERVICE_NAME ?? 'marketplace-orders' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // mixin викликається на КОЖЕН рядок: тут корелятор і зʼявляється «сам».
    mixin() {
      const out: Record<string, string> = {};
      // 🔴 trace_id — з активного спана OTel, а не власний uuid.
      const sc = trace.getActiveSpan()?.spanContext();
      if (sc) {
        out.trace_id = sc.traceId;
        out.span_id = sc.spanId;
      }
      const ctx = currentContext();
      if (ctx?.userId) out.userId = ctx.userId;
      if (ctx?.tenant) out.tenant = ctx.tenant;
      if (ctx?.idempotencyKey) out.idempotencyKey = ctx.idempotencyKey;
      return out;
    },
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  },
  destination,
);

// Поле, яке називає компонент: layerLogger('orders.repo') -> {"layer":"orders.repo",...}
export function layerLogger(layer: string): Logger {
  return rootLogger.child({ layer });
}
