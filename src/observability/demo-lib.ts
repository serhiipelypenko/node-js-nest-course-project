// Спільна обв'язка трьох демо hw-29. Правила, які читає грейдер:
//  • stdout = ЛИШЕ рядки `ключ=число` (діагностика — у stderr);
//  • число рахується з того, що сталося (лог, спани, два скрейпи /metrics), а не друкується «як очікували»;
//  • порушений інваріант = код виходу ≠ 0.
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { close, createObsServer, listen } from './app';
import { addLogTap, setStdoutLogging } from './logger';
import { resetMetrics } from './metrics';
import { memorySpans } from './otel';
import { resetStore } from './orders/repository';

export function note(text: string): void {
  process.stderr.write(`    ${text}\n`);
}

export function header(text: string): void {
  process.stderr.write(`\n━━━ ${text} ━━━\n`);
}

// ── Табло: ключ=число у stdout + перелік порушених інваріантів ─────────────────────────────────────
export class Report {
  private readonly failures: string[] = [];

  print(key: string, value: number | string): void {
    console.log(`${key}=${value}`);
  }

  // Друкує ключ і перевіряє інваріант одним викликом, щоб число й перевірка не розʼїхались.
  expect(key: string, value: number, ok: (v: number) => boolean, rule: string): void {
    this.print(key, value);
    if (!ok(value)) this.failures.push(`${key}=${value} (очікували ${rule})`);
  }

  finish(): never {
    if (this.failures.length) {
      process.stderr.write(`\n✗ ПОРУШЕНО ІНВАРІАНТІВ: ${this.failures.length}\n`);
      for (const f of this.failures) process.stderr.write(`  - ${f}\n`);
      process.exit(1);
    }
    process.stderr.write('\n✓ усі інваріанти тримаються\n');
    process.exit(0);
  }
}

// ── Чистий стан на старті ──────────────────────────────────────────────────────────────────────
export function resetState(): void {
  resetMetrics();
  resetStore();
  memorySpans.reset();
  setStdoutLogging(false); // stdout демо — контракт; рядки логу ловимо підслухачем
}

export function captureLogs(): { lines: string[]; mark: () => number; since: (m: number) => string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = addLogTap((l) => lines.push(l));
  return { lines, mark: () => lines.length, since: (m) => lines.slice(m), stop };
}

export function parseJsonLines(lines: string[]): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* нерозбірливий рядок рахується окремо (non-json-lines) */
    }
  }
  return out;
}

// ── Сервер ─────────────────────────────────────────────────────────────────────────────────────────
export async function startServer(port = 0): Promise<{ base: string; server: http.Server; stop: () => Promise<void> }> {
  const server = createObsServer();
  const actual = await listen(server, port);
  return { base: `http://127.0.0.1:${actual}`, server, stop: () => close(server) };
}

// ── Клієнт: global fetch (undici). 🔴 Не `node:http`: HttpInstrumentation патчить і ВИХІДНІ виклики
// в цьому ж процесі, створює клієнтський спан і ПЕРЕПИСУЄ traceparent — демо б звіряло заголовок,
// якого само не надсилало.
export interface Resp {
  status: number;
  headers: Headers;
  text: string;
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// ── W3C Trace Context: 00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags> ─────────────────────────
export interface Traceparent {
  header: string;
  traceId: string;
  parentId: string;
}

export function newTraceparent(): Traceparent {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { header: `00-${traceId}-${parentId}-01`, traceId, parentId };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined | false, timeoutMs: number, stepMs = 25): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(stepMs);
  }
}

// ── Експозиція /metrics: рахуємо ряди й прирости самі ────────────────────────────────────────────────
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseExposition(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const lm of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

export async function scrape(base: string): Promise<Sample[]> {
  const res = await call(base, 'GET', '/metrics');
  return parseExposition(res.text);
}

export function sum(samples: Sample[], name: string, pred: (s: Sample) => boolean = () => true): number {
  return samples.filter((s) => s.name === name && pred(s)).reduce((a, s) => a + s.value, 0);
}

export function countSeries(samples: Sample[], name: string): number {
  return samples.filter((s) => s.name === name).length;
}
