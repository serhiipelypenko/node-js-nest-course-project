// Headless-демо ізоляції WS-кімнат: два клієнти
// (socket.io-client), кожен зі своїм замовленням; статус замовлення A
// міняється через HTTP (PATCH /orders/:id/status), і лише клієнт у кімнаті
// orders:<A> має це побачити.
//
// hw-24: API закрите, тож скрипт потребує ТРЬОХ access-токенів із оточення
// (отримай через POST /auth/login): ACCESS_A, ACCESS_B — два покупці,
// ACCESS_SELLER — продавець/адмін (лише вони можуть PATCH статусу).
//
// Використання:
//   node scripts/realtime-demo.mjs               # основний прогін: різні кімнати
//   node scripts/realtime-demo.mjs --same-room   # контрольний: обидва в кімнаті A
//
// Порядок навмисно такий: підключити клієнтів -> дочекатись
// ack від join -> лише потім міняти статус. Інакше подія вилетить раніше, ніж
// клієнт опиниться в кімнаті.
import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SAME_ROOM = process.argv.includes('--same-room');

const { ACCESS_A, ACCESS_B, ACCESS_SELLER } = process.env;
if (!ACCESS_A || !ACCESS_B || !ACCESS_SELLER) {
  console.error('потрібні ACCESS_A, ACCESS_B, ACCESS_SELLER (access-токени з POST /auth/login)');
  process.exit(1);
}

async function createOrder(label, token) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': `realtime-demo-${label}-${Date.now()}-${Math.random()}`,
    },
    body: JSON.stringify({ items: [{ product_id: 'p1', quantity: 1 }] }),
  });
  if (!res.ok) {
    throw new Error(`POST /orders (${label}) -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function setStatus(orderId, status) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_SELLER}` },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /orders/${orderId}/status -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function connect(token) {
  return io(BASE_URL, {
    auth: { token },
    reconnection: false,
  });
}

function join(socket, orderId) {
  // Nest WsResponse — це НЕ socket.io-ack: сервер (orders.gateway.ts)
  // повертає {event: 'joined', data}, і Nest сам емітить його назад як
  // ЗВИЧАЙНУ подію на цей самий сокет — тому чекаємо саме 'joined', а не
  // callback третім аргументом emit().
  return new Promise((resolve, reject) => {
    socket.once('joined', (ack) => {
      if (ack?.ok) resolve(ack);
      else reject(new Error(`join(${orderId}) відхилено: ${ack?.reason ?? 'невідома причина'}`));
    });
    socket.emit('join', orderId);
  });
}

async function main() {
  const orderA = await createOrder('a', ACCESS_A);
  const orderB = await createOrder('b', ACCESS_B);
  console.log(`замовлення A=${orderA.id}, B=${orderB.id}`);
  console.log(SAME_ROOM ? 'режим: --same-room (контрольний)' : 'режим: основний (різні кімнати)');

  const clientA = connect(ACCESS_A);
  // Контрольний режим: B заходить у кімнату A, тому й підключається під
  // тим самим токеном, що й власник A — інакше join(orderA.id) від B
  // відхилила б перевірка власності, і ми виміряли б відмову
  // на join, а не ізоляцію кімнат.
  const clientB = connect(SAME_ROOM ? ACCESS_A : ACCESS_B);

  let aReceived = false;
  let bReceived = false;
  clientA.on('order.status', (e) => {
    if (e.orderId === orderA.id) aReceived = true;
  });
  clientB.on('order.status', (e) => {
    if (e.orderId === orderA.id) bReceived = true;
  });

  await Promise.all([
    new Promise((resolve, reject) => clientA.on('connect', resolve).on('connect_error', reject)),
    new Promise((resolve, reject) => clientB.on('connect', resolve).on('connect_error', reject)),
  ]);

  await join(clientA, orderA.id);
  await join(clientB, SAME_ROOM ? orderA.id : orderB.id);

  await setStatus(orderA.id, 'packed');
  // Дати подіям доїхати мережею/event loop-ом, перш ніж читати прапорці.
  await new Promise((resolve) => setTimeout(resolve, 500));

  clientA.close();
  clientB.close();

  console.log(`A_RECEIVED=${aReceived ? 1 : 0}`);
  console.log(`B_RECEIVED=${bReceived ? 1 : 0}`);

  const expectedB = SAME_ROOM ? 1 : 0;
  const ok = aReceived && (bReceived ? 1 : 0) === expectedB;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
