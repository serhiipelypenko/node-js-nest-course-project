// demo:reuse — ⭐ повторне використання refresh валить УСЮ сімʼю.
//
// Ротація без детекції нічого не дає: злодій рефрешиться першим, чесний клієнт
// отримує 401 і мовчки перелогінюється, а сесія злодія живе далі. Тому
// `r1-reuse=401` вміє й проста ротація, а ГОЛОВНИЙ рядок — `r2-after-reuse=401`:
// після сигналу компрометації вилітає і поточний токен R2 (його тримає «чесний
// клієнт» або сам злодій — відрізнити не можна).
// RFC 9700 §4.14.2: ротація з детекцією повтору — і зв'язок старого токена з
// новим (family_id) зберігається саме для того, щоб було чим відкликати.
import { runDemo } from './auth/demo-lib';

const EMAIL = 'demo-reuse@auth.test';

runDemo('demo:reuse', async (d) => {
  await d.user(EMAIL, 'customer');

  const login = await d.call('POST', '/auth/login', { body: { email: EMAIL, password: 'demo-password-1' } });
  d.expect('login', login.status, [200]);
  const r1: string = login.body.refresh_token;

  // R1 -> R2: чесна ротація.
  const rotated = await d.call('POST', '/auth/refresh', { body: { refresh_token: r1 } });
  d.expect('r1-refresh', rotated.status, [200]);
  const r2: string = rotated.body.refresh_token;

  // R1 пред'явлено вдруге — «злодій» (або зламаний клієнт). Сімʼя помирає.
  d.expect('r1-reuse', (await d.call('POST', '/auth/refresh', { body: { refresh_token: r1 } })).status, [401]);

  // R2 — валідний, ніким не використаний, але з тієї ж сімʼї -> теж 401.
  d.expect('r2-after-reuse', (await d.call('POST', '/auth/refresh', { body: { refresh_token: r2 } })).status, [401]);

  const alive = await d.pool.query(
    `SELECT count(*)::int AS n FROM refresh_tokens r JOIN users u ON u.id = r.user_id
      WHERE u.email = $1 AND r.revoked_at IS NULL`,
    [EMAIL],
  );
  d.invariant('після виявлення повтору в сімʼї немає живих токенів', alive.rows[0].n === 0);
});
