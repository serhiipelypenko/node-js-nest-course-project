// demo:rbac — 401 ≠ 403, власність, роль і перевірка підпису.
//
//   anon         — немає токена                         -> 401 (хто це?)
//   own          — власник читає своє замовлення        -> 200
//   foreign      — валідний токен ЧУЖОГО покупця        -> 403 (можна йому це?)
//   role-denied  — покупець пише в products             -> 403 (рівень РОЛІ)
//   role-allowed — продавець пише в products            -> 201
//   tampered     — payload підмінено (role -> admin), підпис старий -> 401:
//                  підпис справді ПЕРЕВІРЯЄТЬСЯ, а не decode-ається.
import { runDemo } from './auth/demo-lib';

runDemo('demo:rbac', async (d) => {
  await d.user('demo-owner@auth.test', 'customer');
  await d.user('demo-stranger@auth.test', 'customer');
  await d.user('demo-seller@auth.test', 'seller');
  const owner = await d.login('demo-owner@auth.test');
  const stranger = await d.login('demo-stranger@auth.test');
  const seller = await d.login('demo-seller@auth.test');

  const created = await d.call('POST', '/orders', {
    token: owner.access_token,
    headers: { 'Idempotency-Key': 'demo-rbac-order-1' },
    body: { items: [{ product_id: 'p1', quantity: 1 }] },
  });
  d.invariant(`замовлення створено (POST /orders -> ${created.status})`, created.status === 201);
  const path = `/orders/${created.body.id}`;

  d.expect('anon', (await d.call('GET', path)).status, [401]);
  d.expect('own', (await d.call('GET', path, { token: owner.access_token })).status, [200]);
  d.expect('foreign', (await d.call('GET', path, { token: stranger.access_token })).status, [403]);

  const product = { name: 'Веб-камера', price_cents: 99900 };
  d.expect('role-denied', (await d.call('POST', '/products', { token: owner.access_token, body: product })).status, [403]);
  d.expect('role-allowed', (await d.call('POST', '/products', { token: seller.access_token, body: product })).status, [200, 201]);

  // Ті самі три рядки, що в task.md: payload міняємо, підпис лишаємо старий.
  // Ключ для цього не потрібен — і саме тому підробка має ламатись.
  const parts = owner.access_token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.role = 'admin';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  d.expect('tampered', (await d.call('POST', '/products', { token: parts.join('.'), body: product })).status, [401]);
});
