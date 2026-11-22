// demo:contour — головний наскрізний контур курсового (ТЗ, розділ 4) на запущеному
// сервісі: запит -> валідація -> права -> бізнес-логіка -> Postgres -> outbox ->
// повторне читання окремим запитом. Застосунок піднімається в цьому ж процесі
// (harness hw-24), друкуються лише `ключ=число`, на зламаному інваріанті exit ≠ 0.
//
//   anon / foreign / bad-body / no-key / oversell — негативні шляхи (401/403/400/400/409)
//   created   — POST /orders -> 201;  replay — той самий Idempotency-Key -> та сама id
//   read      — окремий GET /orders/:id -> 200, status=new
//   packed    — PATCH статусу продавцем -> 200, і окремий GET бачить `packed`
//   orders-for-key / outbox / stock-spent — у БД рівно по одному на дві спроби
import { runDemo } from './auth/demo-lib';

runDemo('demo:contour', async (d) => {
  await d.user('contour-buyer@auth.test', 'customer');
  await d.user('contour-stranger@auth.test', 'customer');
  await d.user('contour-seller@auth.test', 'seller');
  const buyer = (await d.login('contour-buyer@auth.test')).access_token;
  const stranger = (await d.login('contour-stranger@auth.test')).access_token;
  const seller = (await d.login('contour-seller@auth.test')).access_token;

  // Продавець наповнює каталог (рівень РОЛІ), покупець купує.
  const product = await d.call('POST', '/products', {
    token: seller,
    body: { name: 'Товар контуру', price_cents: 25000, stock: 5 },
  });
  d.expect('product-created', product.status, [201]);
  const productId = String(product.body.id);

  const key = `contour-${Date.now()}`;
  const order = { items: [{ product_id: productId, quantity: 2 }] };
  const post = (body: unknown, headers: Record<string, string> = { 'Idempotency-Key': key }, token: string | null = buyer) =>
    d.call('POST', '/orders', { token: token ?? undefined, headers, body });

  d.expect('anon', (await post(order, { 'Idempotency-Key': key }, null)).status, [401]);
  d.expect('no-key', (await post(order, {})).status, [400]);
  d.expect('bad-body', (await post({ items: [] })).status, [400]);

  const created = await post(order);
  d.expect('created', created.status, [201]);
  const replay = await post(order);
  d.expect('replay', replay.status, [201]);
  d.invariant('повтор ключа віддав те саме замовлення', replay.body.id === created.body.id);

  const path = `/orders/${created.body.id}`;
  const read = await d.call('GET', path, { token: buyer });
  d.expect('read', read.status, [200]);
  d.invariant('читання бачить status=new і суму 2×25000', read.body.status === 'new' && read.body.total_cents === 50000);
  d.expect('foreign', (await d.call('GET', path, { token: stranger })).status, [403]);

  // Бізнес-правило під конкуренцією: на складі 5, 2 вже куплено -> 4 не вистачить.
  d.expect('oversell', (await post({ items: [{ product_id: productId, quantity: 4 }] }, { 'Idempotency-Key': `${key}-big` })).status, [409]);

  const patched = await d.call('PATCH', `${path}/status`, { token: seller, body: { status: 'packed' } });
  d.expect('packed', patched.status, [200]);
  const after = await d.call('GET', path, { token: buyer });
  d.invariant('окремий GET бачить packed', after.body.status === 'packed');

  const { rows } = await d.pool.query<{ orders: number; outbox: number; stock: number }>(
    `SELECT (SELECT count(*) FROM idempotency_keys WHERE key LIKE '%:' || $2)::int AS orders,
            (SELECT count(*) FROM outbox WHERE aggregate_id = $1)::int AS outbox,
            (SELECT stock FROM products WHERE id = $3)::int AS stock`,
    [String(created.body.id), key, productId],
  );
  console.log(`orders-for-key=${rows[0]!.orders}`);
  console.log(`outbox=${rows[0]!.outbox}`);
  console.log(`stock-spent=${5 - rows[0]!.stock}`);
  d.invariant('одна спроба = одне замовлення', rows[0]!.orders === 1);
  d.invariant('подія в outbox рівно одна', rows[0]!.outbox === 1);
  d.invariant('склад списано один раз (2 з 5)', rows[0]!.stock === 3);
});
