// OTel — ПЕРШИМ імпортом (до `http`).
import './observability/otel';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { flushTelemetry, memorySpans } from './observability/otel';
import { FAULT_SKU } from './observability/orders/repository';
import {
  Report,
  call,
  captureLogs,
  header,
  newTraceparent,
  note,
  parseJsonLines,
  resetState,
  sleep,
  startServer,
  until,
} from './observability/demo-lib';

// demo:trace — ТЕЗА (в): один ключ відчиняє двоє дверей. trace_id у рядку логу = trace_id спана = той, що приїхав
// у заголовку traceparent (W3C Trace Context: 00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>).
const spansOf = (traceId: string): ReadableSpan[] =>
  memorySpans.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);

// Серверний спан завершується ПІСЛЯ того, як клієнт отримав відповідь, — чекаємо на нього, а не спимо навмання.
const waitServerSpan = (traceId: string) =>
  until(() => spansOf(traceId).find((s) => s.kind === SpanKind.SERVER), 3000);

async function main() {
  resetState();
  const logs = captureLogs();
  const { base, stop } = await startServer();
  const report = new Report();

  // ── 1. Успішний запит з вхідним traceparent ───────────────────────────────────────────────────────
  header('1 · POST /orders із вхідним traceparent');
  const tp = newTraceparent();
  const m1 = logs.mark();
  const ok = await call(base, 'POST', '/orders', {
    headers: { traceparent: tp.header, 'idempotency-key': 'idem-trace-1', 'x-user-id': 'user-1' },
    body: { sku: 'sku-demo', qty: 1 },
  });
  note(`→ ${ok.status}; заголовок: ${tp.header}`);
  const server = await waitServerSpan(tp.traceId);
  const spans = spansOf(tp.traceId);
  for (const s of spans) {
    note(`${s.name.padEnd(24)} kind=${SpanKind[s.kind]} span=${s.spanContext().spanId} parent=${s.parentSpanContext?.spanId ?? '—'}`);
  }

  // spans — серверний спан плюс щонайменше один вкладений
  report.expect('spans', spans.length, (v) => v >= 2, '≥ 2');
  // сирота = спан, чий батько не серед спанів цього трейсу і не є parent-id із заголовка
  const ids = new Set(spans.map((s) => s.spanContext().spanId));
  const orphans = spans.filter((s) => {
    const p = s.parentSpanContext?.spanId;
    return !p || (!ids.has(p) && p !== tp.parentId);
  }).length;
  report.expect('orphan-spans', orphans, (v) => v === 0, '0');

  // двері 1: спан продовжив ВХІДНИЙ трейс — той самий trace-id і батько = parent-id із заголовка
  const matchesHeader =
    server && server.spanContext().traceId === tp.traceId && server.parentSpanContext?.spanId === tp.parentId ? 1 : 0;
  report.expect('trace-matches-header', matchesHeader, (v) => v === 1, '1');

  // двері 2: КОЖЕН рядок логу цього запиту несе trace_id і span_id спана, а не власний uuid
  const lines = parseJsonLines(logs.since(m1));
  const matchesLog =
    server && lines.length > 0 && lines.every((o) => o.trace_id === server.spanContext().traceId && ids.has(o.span_id)) ? 1 : 0;
  note(`рядків логу запиту: ${lines.length}; усі з trace_id=${tp.traceId}: ${matchesLog === 1}`);
  report.expect('trace-matches-log', matchesLog, (v) => v === 1, '1');

  // ── 2. Запит із 5xx: спан зі статусом ERROR ───────────────────────────────────────────────────────
  header('2 · POST /orders зі збоєм репозиторію → 500');
  const tpFail = newTraceparent();
  const fail = await call(base, 'POST', '/orders', {
    headers: { traceparent: tpFail.header, 'idempotency-key': 'idem-trace-2' },
    body: { sku: FAULT_SKU, qty: 1 },
  });
  const failServer = await waitServerSpan(tpFail.traceId);
  await until(() => spansOf(tpFail.traceId).length >= 2, 3000);
  const statusError = failServer?.status.code === SpanStatusCode.ERROR ? 1 : 0;
  note(`→ ${fail.status}; серверний спан status=${failServer ? SpanStatusCode[failServer.status.code] : '—'}`);
  report.expect('span-status-error', statusError, (v) => v === 1, '1');

  // ── 3. Контроль: 4xx для OTel — НЕ помилка спана (Unset) ──────────────────────────────────────────
  header('3 · POST /orders без Idempotency-Key → 400: статус спана лишається Unset');
  const tp4 = newTraceparent();
  const bad = await call(base, 'POST', '/orders', { headers: { traceparent: tp4.header }, body: { sku: 'sku-demo', qty: 1 } });
  const s4 = await waitServerSpan(tp4.traceId);
  note(`→ ${bad.status}; статус спана: ${s4 ? SpanStatusCode[s4.status.code] : '—'}`);
  report.print('span-status-4xx-unset', s4?.status.code === SpanStatusCode.UNSET ? 1 : 0);

  report.print('trace-id', tp.traceId);

  // ── 4. (довідково, не гейтиться) Той самий trace_id у Tempo ────────────────────────────────────────
  // 🔴 Батчевий експортер шле не одразу: спершу forceFlush(), потім опитування бека з таймаутом.
  await flushTelemetry();
  const api = process.env.TRACE_API_URL;
  if (api && process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    header('4 · Tempo: той самий trace_id (довідково)');
    let inTempo = 0;
    for (let i = 0; i < 40 && inTempo === 0; i++) {
      try {
        const r = await fetch(`${api}/api/traces/${tp.traceId}`);
        if (r.status === 200) {
          const j = (await r.json()) as Record<string, any>;
          const batches: any[] = j.batches ?? j.resourceSpans ?? [];
          inTempo = batches.reduce(
            (a, b) => a + (b.scopeSpans ?? b.instrumentationLibrarySpans ?? []).reduce((x: number, y: any) => x + (y.spans ?? []).length, 0),
            0,
          );
        }
      } catch {
        /* стенд не піднятий */
      }
      if (inTempo === 0) await sleep(1000);
    }
    report.print('tempo-spans', inTempo);
  }

  logs.stop();
  await stop();
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
