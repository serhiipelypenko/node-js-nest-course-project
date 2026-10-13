// hw-19: контракт події order.placed — свідомо спроектований DTO, а не
// ORM-сутність через spread. Версіонується полем type; нові поля — лише
// додаванням (ДЗ #22/#23 читатимуть цю саму подію).
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const OrderPlacedSchema = z.object({
  eventId: z.string().uuid(),
  type: z.literal('order.placed'),
  occurredAt: z.string().datetime(),
  data: z.object({
    orderId: z.string().min(1),
    buyerId: z.string().min(1),
    productId: z.string().min(1),
    quantity: z.number().int().positive(),
    totalAmount: z.number().nonnegative(),
  }),
});

export type OrderPlacedEvent = z.infer<typeof OrderPlacedSchema>;

// eventId СТАБІЛЬНИЙ: похідний від ключа бізнес-операції (id замовлення), а не
// випадковий UUID на кожну спробу публікації. Тому повторна публікація тієї
// самої події (retry після втраченого confirm) має той самий eventId, і
// споживач упізнає дубль. Формат — UUID (v5-подібний, sha1 від імені).
export function eventIdFor(type: string, businessKey: string): string {
  const h = createHash('sha1').update(`${type}:${businessKey}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildOrderPlaced(data: OrderPlacedEvent['data']): OrderPlacedEvent {
  return {
    eventId: eventIdFor('order.placed', data.orderId),
    type: 'order.placed',
    occurredAt: new Date().toISOString(),
    data,
  };
}

// hw-22: явний маппінг рядка замовлення -> контракт події. НЕ `{ ...order }`:
// інакше схема таблиці orders стає публічним API, і перше ж перейменування
// колонки ламає всіх консюмерів. occurredAt фіксується в момент запису в outbox
// і далі не змінюється: повторна публікація віддає ті самі байти.
export function toOrderPlacedEvent(order: {
  id: string;
  buyerId: string;
  productId: string;
  quantity: number;
  totalAmount: number;
  placedAt: Date;
}): OrderPlacedEvent {
  return {
    eventId: eventIdFor('order.placed', order.id),
    type: 'order.placed',
    occurredAt: order.placedAt.toISOString(),
    data: {
      orderId: order.id,
      buyerId: order.buyerId,
      productId: order.productId,
      quantity: order.quantity,
      totalAmount: order.totalAmount,
    },
  };
}
