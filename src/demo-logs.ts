// OTel — ПЕРШИМ імпортом (до `http`).
import './observability/otel';
import { randomBytes } from 'node:crypto';
import { rootLogger } from './observability/logger';
import {
  Report,
  call,
  captureLogs,
  header,
  newTraceparent,
  note,
  parseJsonLines,
  resetState,
  startServer,
} from './observability/demo-lib';

// demo:logs — ТЕЗА (а): корелятор живе в контексті, а не в аргументах функцій. Вісім і більше паралельних запитів
// не перемішуються, найглибший шар має той самий ідентифікатор, секрети в лог не потрапляють.
const BURST = Number(process.env.BURST ?? 12);

async function main() {
  resetState();
  const logs = captureLogs();
  const { base, stop } = await startServer();
  const report = new Report();

  // ── 1. Один запит: три шари, один trace_id, і він дорівнює заголовку traceparent ────────────────────
  header('1 · Один запит через controller → service → repository');
  const tp = newTraceparent();
  const m1 = logs.mark();
  const res1 = await call(base, 'POST', '/orders', {
    headers: { traceparent: tp.header, 'idempotency-key': 'idem-logs-1', 'x-user-id': 'user-1', 'x-tenant-id': 'acme' },
    body: { sku: 'sku-demo', qty: 2 },
  });
  note(`POST /orders → ${res1.status}`);
  const one = parseJsonLines(logs.since(m1));
  for (const o of one) note(`${String(o.layer).padEnd(18)} trace_id=${o.trace_id} ${o.msg}`);

  const layers = new Set(one.map((o) => o.layer)).size;
  const distinct = new Set(one.map((o) => o.trace_id)).size;
  const matchesHeader = one.length > 0 && one.every((o) => o.trace_id === tp.traceId) ? 1 : 0;
  // userId / tenant / idempotencyKey — з AsyncLocalStorage: нижні шари не приймають `req`.
  const alsComplete =
    one.length > 0 && one.every((o) => o.userId === 'user-1' && o.tenant === 'acme' && o.idempotencyKey === 'idem-logs-1') ? 1 : 0;
  report.expect('layers', layers, (v) => v >= 3, '≥ 3');
  report.expect('distinct-trace-ids', distinct, (v) => v === 1, '1');
  report.expect('trace-id-matches-header', matchesHeader, (v) => v === 1, '1');
  report.expect('als-fields-complete', alsComplete, (v) => v === 1, '1');

  // ── 2. Берст: N однакових запитів паралельно, кожен зі своїм traceparent і своїм userId ──────────────
  header(`2 · Берст: ${BURST} однакових запитів паралельно`);
  const sent = Array.from({ length: BURST }, (_, i) => ({ tp: newTraceparent(), user: `user-${i}` }));
  const m2 = logs.mark();
  await Promise.all(
    sent.map((s) => call(base, 'GET', '/orders/7', { headers: { traceparent: s.tp.header, 'x-user-id': s.user, 'x-tenant-id': 'acme' } })),
  );
  const burstLines = parseJsonLines(logs.since(m2));
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const o of burstLines) {
    const k = String(o.trace_id);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const sizes = [...groups.values()].map((g) => g.length);
  const uneven = sizes.length ? Math.max(...sizes) - Math.min(...sizes) : -1;
  // найсильніша перевірка: рядки групи належать САМЕ тому userId, чий це запит (змінна модуля тут би збрехала)
  const userOf = new Map(sent.map((s) => [s.tp.traceId, s.user]));
  const mixed = [...groups.entries()].filter(([tid, g]) => g.some((o) => o.userId !== userOf.get(tid))).length;
  note(`груп за trace_id: ${groups.size}; розміри: ${sizes.join(',')}; груп із чужим userId: ${mixed}`);
  report.expect('burst', BURST, (v) => v >= 8, '≥ 8');
  report.expect('burst-trace-ids', groups.size, (v) => v === BURST, String(BURST));
  report.expect('burst-uneven', uneven, (v) => v === 0, '0');
  report.expect('burst-foreign-user', mixed, (v) => v === 0, '0');

  // ── 3. Секрети: Authorization і пароль з тіла входу (ДЗ #24) ─────────────────────────────────────────
  header('3 · Redaction: Authorization і пароль у лог не потрапляють');
  const bearer = `BEARER${randomBytes(8).toString('hex')}`;
  const password = `PASSWD${randomBytes(8).toString('hex')}`;
  const m3 = logs.mark();
  const res3 = await call(base, 'POST', '/auth/login', {
    headers: { authorization: `Bearer ${bearer}`, 'x-user-id': 'user-9' },
    body: { email: 'a@b.c', password },
  });
  note(`POST /auth/login → ${res3.status}`);
  const secretLines = logs.since(m3);
  // рядок запиту Є в лозі (інакше «секретів немає» нічого б не доводило)…
  const reqLogged = parseJsonLines(secretLines).some((o) => o.req?.url === '/auth/login' && o.msg === 'запит прийнято') ? 1 : 0;
  // …а маркерів у ЖОДНОМУ рядку всього прогону немає
  const everything = logs.lines.join('\n');
  const leaked = (everything.includes(bearer) ? 1 : 0) + (everything.includes(password) ? 1 : 0);
  report.expect('secret-req-logged', reqLogged, (v) => v === 1, '1');
  report.expect('secret-in-logs', leaked, (v) => v === 0, '0');

  // Контрольна проба «redact не вгадує»: шлях body.profile.token НЕ описаний — і текуть саме там.
  // Не гейтиться: це довід, чому список шляхів явний (README → Observability).
  const probe = `NESTED${randomBytes(8).toString('hex')}`;
  const mp = logs.mark();
  rootLogger.info({ body: { profile: { token: probe } } }, 'проба: неописаний шлях');
  report.print('unlisted-path-leak', logs.since(mp).join('\n').includes(probe) ? 1 : 0);

  // ── Контракт ────────────────────────────────────────────────────────────────────────────────────────
  const nonJson = logs.lines.filter((l) => {
    try {
      JSON.parse(l);
      return false;
    } catch {
      return true;
    }
  }).length;
  report.expect('non-json-lines', nonJson, (v) => v === 0, '0');

  logs.stop();
  await stop();
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
