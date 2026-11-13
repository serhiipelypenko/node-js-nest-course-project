// OTel — ПЕРШИМ імпортом (до `http`).
import './observability/otel';
import { TOP_FINITE_BUCKET } from './observability/metrics';
import { FAULT_SKU, SLOW_SKU } from './observability/orders/repository';
import {
  Report,
  call,
  countSeries,
  header,
  note,
  resetState,
  scrape,
  sleep,
  startServer,
  sum,
} from './observability/demo-lib';

// demo:metrics — ТЕЗА (б): множина значень лейбла обмежена — сто різних id не додають жодного нового ряду.
// Усе рахується з двох скрейпів /metrics, а не з лічильників демо.
const SENT = Number(process.env.SENT ?? 60);
const IDS = Number(process.env.IDS ?? 100);
const ROUTE = '/orders';
// Фіксований порт (а не ефемерний): Prometheus зі стенда скрейпить host.docker.internal:22900.
const PORT = Number(process.env.OBS_APP_PORT ?? 22900);

async function main() {
  resetState();
  const { base, stop } = await startServer(PORT);
  const report = new Report();

  // ── 1. RED рахує те, що справді сталося ───────────────────────────────────────────────────────────
  header(`1 · ${SENT} запитів POST ${ROUTE}: частина зі збоєм репозиторію (5xx), один повільний`);
  const before = await scrape(base);
  const routeOnly = (s: { labels: Record<string, string> }) => s.labels.route === ROUTE;
  const total0 = sum(before, 'http_requests_total', routeOnly);
  const errors0 = sum(before, 'http_requests_total', (s) => routeOnly(s) && /^5\d\d$/.test(s.labels.status ?? ''));

  let sentOk = 0;
  let sentFail = 0;
  let unexpected = 0;
  const one = async (i: number) => {
    // кожен 4-й — збій (5xx), 6-й (i=5) — повільний запис (хвіст гістограми), решта — звичайні
    const sku = i % 4 === 3 ? FAULT_SKU : i === 5 ? SLOW_SKU : 'sku-demo';
    const res = await call(base, 'POST', ROUTE, { headers: { 'idempotency-key': `idem-metrics-${i}` }, body: { sku, qty: 1 + (i % 3) } });
    if (res.status === 201) sentOk++;
    else if (res.status === 500) sentFail++;
    else unexpected++;
  };
  for (let i = 0; i < SENT; i += 10) {
    await Promise.all(Array.from({ length: Math.min(10, SENT - i) }, (_, k) => one(i + k)));
  }
  const after = await scrape(base);
  const counterDelta = sum(after, 'http_requests_total', routeOnly) - total0;
  const errorsDelta = sum(after, 'http_requests_total', (s) => routeOnly(s) && /^5\d\d$/.test(s.labels.status ?? '')) - errors0;
  note(`надіслано ok=${sentOk} fail=${sentFail} інших=${unexpected}; приріст лічильника=${counterDelta}, 5xx=${errorsDelta}`);
  report.print('sent-ok', sentOk);
  report.print('sent-fail', sentFail);
  report.expect('sent-total', sentOk + sentFail, (v) => v >= 50 && unexpected === 0, '≥ 50 і лише 201/500');
  report.expect('counter-delta', counterDelta, (v) => v === sentOk + sentFail, 'sent-ok + sent-fail');
  report.expect('errors-delta', errorsDelta, (v) => v === sentFail, 'sent-fail');

  // ── 2. Бакети покривають діапазон ─────────────────────────────────────────────────────────────────
  header(`2 · Верхній скінченний бакет (${TOP_FINITE_BUCKET} с) більший за найгірший випадок`);
  const count = sum(after, 'http_request_duration_seconds_count', routeOnly);
  const topBucket = sum(
    after,
    'http_request_duration_seconds_bucket',
    (s) => routeOnly(s) && Number(s.labels.le) === TOP_FINITE_BUCKET,
  );
  const slowestBucket = [...new Set(after.filter((s) => s.name === 'http_request_duration_seconds_bucket' && routeOnly(s)).map((s) => s.labels.le))]
    .filter((le) => le !== '+Inf')
    .map(Number)
    .sort((a, b) => a - b)
    .find((le) => sum(after, 'http_request_duration_seconds_bucket', (s) => routeOnly(s) && Number(s.labels.le) === le) === count);
  note(`_count=${count}; найменший бакет, що вміщає всі запити: le=${slowestBucket}`);
  report.print('slowest-fits-le', slowestBucket ?? 'inf');
  report.expect('above-top-bucket', count - topBucket, (v) => v === 0, '0');

  // ── 3. Кардинальність: сто різних id — жодного нового ряду ─────────────────────────────────────────
  header(`3 · ${IDS} запитів GET /orders/:id зі ${IDS} різними id`);
  // 🔴 Спершу прогріти маршрут ОДНИМ запитом: перший запит у новий маршрут створює ряд, і це не кардинальність id.
  await call(base, 'GET', '/orders/warmup');
  const seriesBefore = countSeries(await scrape(base), 'http_requests_total');
  const durBefore = countSeries(await scrape(base), 'http_request_duration_seconds_count');
  const ids = Array.from({ length: IDS }, (_, i) => `id-${String(i).padStart(4, '0')}-${(i * 7919) % 10007}`);
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map((id) => call(base, 'GET', `/orders/${id}`)));
  }
  const final = await scrape(base);
  const seriesAfter = countSeries(final, 'http_requests_total');
  const durAfter = countSeries(final, 'http_request_duration_seconds_count');
  const rawPathsInLabels = final.filter((s) => s.name === 'http_requests_total' && /id-\d{4}/.test(s.labels.route ?? '')).length;
  note(`різних сирих шляхів надіслано: ${new Set(ids).size}; сирих шляхів у лейблі route: ${rawPathsInLabels}`);
  report.print('distinct-ids-sent', new Set(ids).size);
  report.print('series-before', seriesBefore);
  report.expect('series-after', seriesAfter, (v) => v === seriesBefore, 'series-before');
  report.expect('duration-series-after', durAfter, (v) => v === durBefore, 'duration-series-before');
  report.expect('raw-path-in-route', rawPathsInLabels, (v) => v === 0, '0');

  // ── 4. (довідково, не гейтиться) Prometheus зі стенда бачить те саме число ────────────────────────────
  const prom = process.env.PROMETHEUS_URL;
  if (prom) {
    header('4 · Prometheus зі стенда: те саме число (довідково)');
    const appTotal = sum(final, 'http_requests_total');
    let seen = NaN;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${prom}/api/v1/query?query=${encodeURIComponent('sum(http_requests_total)')}`);
        const j = (await r.json()) as { data?: { result?: Array<{ value: [number, string] }> } };
        seen = Number(j.data?.result?.[0]?.value?.[1] ?? NaN);
      } catch {
        /* стенд не піднятий — довідковий рядок просто покаже NaN */
      }
      if (seen === appTotal) break;
      await sleep(500);
    }
    report.print('prometheus-counter-total', Number.isNaN(seen) ? -1 : seen);
    report.print('prometheus-matches-app', seen === appTotal ? 1 : 0);
  }

  await stop();
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
