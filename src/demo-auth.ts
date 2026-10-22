// demo:auth — логін, доступ, refresh і ЛОГАУТ, який вбиває ОБИДВА токени.
//
// Чому логаут — це дві дії (README «Auth»): refresh — рядок у БД, його досить
// позначити revoked; access self-contained і сам по собі живе до exp, тож
// потрібен денилист. `after-logout=401` — доказ денилиста: без нього той самий
// access після логауту дав би 200.
import { runDemo } from './auth/demo-lib';

const EMAIL = 'demo-auth@auth.test';

runDemo('demo:auth', async (d) => {
  await d.user(EMAIL, 'customer');

  const login = await d.call('POST', '/auth/login', { body: { email: EMAIL, password: 'demo-password-1' } });
  d.expect('login', login.status, [200]);
  const first = login.body;

  d.expect('no-token', (await d.call('GET', '/orders')).status, [401]);
  d.expect('with-token', (await d.call('GET', '/orders', { token: first.access_token })).status, [200]);

  const refreshed = await d.call('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
  d.expect('refresh', refreshed.status, [200]);
  const second = refreshed.body;

  // Логаут під НОВОЮ парою: його fid той самий, що й у першої (одна сімʼя).
  d.expect('logout', (await d.call('POST', '/auth/logout', { token: second.access_token })).status, [200, 204]);

  // Дві різні смерті: access — через денилист, refresh — через revoked_at сімʼї.
  d.expect('after-logout', (await d.call('GET', '/orders', { token: second.access_token })).status, [401]);
  d.expect('refresh-after-logout', (await d.call('POST', '/auth/refresh', { body: { refresh_token: second.refresh_token } })).status, [401]);

  // Інваріанти поза HTTP — обидві дії логауту дійсно лягли в БД одним COMMIT.
  const alive = await d.pool.query(
    `SELECT count(*)::int AS n FROM refresh_tokens r JOIN users u ON u.id = r.user_id
      WHERE u.email = $1 AND r.revoked_at IS NULL`,
    [EMAIL],
  );
  d.invariant('після логауту немає невідкликаних refresh-токенів', alive.rows[0].n === 0);
  const denied = await d.pool.query(`SELECT count(*)::int AS n FROM access_denylist`);
  d.invariant('jti access-токена у денилисті', denied.rows[0].n === 1);
});
