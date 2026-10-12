// hw-19: топологія оголошується на боці споживача/бутстрапу, НЕ продюсера —
// продюсер знає лише exchange і routing key, а не те, хто його слухає.
//
//   producer ──order.placed──▶ [shop.events : topic] ──binding──▶ (shop.order-placed : quorum)
//                                   │ alternate-exchange                    │ x-dead-letter-exchange
//                                   ▼                                       ▼
//                         [shop.unroutable : fanout]            [shop.dlx : direct] ──▶ (shop.order-placed.dlq)
//                                   ▼
//                          (shop.unroutable)
import type { Channel } from 'amqplib';

export const EXCHANGE = 'shop.events';
export const ROUTING_KEY_ORDER_PLACED = 'order.placed';
export const WORK_QUEUE = 'shop.order-placed';

export const DLX = 'shop.dlx';
export const DLQ = 'shop.order-placed.dlq';

// alternate exchange: повідомлення, для якого не знайшлось жодного binding,
// не зникає мовчки (брокер дав би продюсеру позитивний confirm), а лягає сюди.
export const ALT_EXCHANGE = 'shop.unroutable';
export const UNROUTABLE_QUEUE = 'shop.unroutable';

// Після 5 повернень повідомлення йде в DLX з причиною delivery_limit — без
// ліміту «отруєне» повідомлення з requeue=true крутилось би вічно.
const DELIVERY_LIMIT = 5;

export async function assertTopology(ch: Channel): Promise<void> {
  // Аргументи черги/exchange незмінні: змінити їх на існуючому обʼєкті
  // не можна (406 PRECONDITION_FAILED) — лише delete + create.
  await ch.assertExchange(ALT_EXCHANGE, 'fanout', { durable: true });
  await ch.assertQueue(UNROUTABLE_QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(UNROUTABLE_QUEUE, ALT_EXCHANGE, '');

  await ch.assertExchange(EXCHANGE, 'topic', {
    durable: true,
    arguments: { 'alternate-exchange': ALT_EXCHANGE },
  });

  await ch.assertExchange(DLX, 'direct', { durable: true });
  await ch.assertQueue(DLQ, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(DLQ, DLX, ROUTING_KEY_ORDER_PLACED);

  await ch.assertQueue(WORK_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DLX,
      'x-dead-letter-routing-key': ROUTING_KEY_ORDER_PLACED,
      'x-delivery-limit': DELIVERY_LIMIT,
    },
  });
  await ch.bindQueue(WORK_QUEUE, EXCHANGE, ROUTING_KEY_ORDER_PLACED);
}

export async function purgeAll(ch: Channel): Promise<void> {
  for (const q of [WORK_QUEUE, DLQ, UNROUTABLE_QUEUE]) await ch.purgeQueue(q);
}

export async function depth(ch: Channel, queue: string): Promise<number> {
  return (await ch.checkQueue(queue)).messageCount;
}
