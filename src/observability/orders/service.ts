// Шар сервісу: теж без `req`.
import { randomUUID } from 'node:crypto';
import { layerLogger } from '../logger';
import { type OrderRecord, findOrder, insertOrder } from './repository';

const log = layerLogger('orders.service');

export interface CreateOrderInput {
  sku: string;
  qty: number;
}

export async function createOrder(input: CreateOrderInput): Promise<OrderRecord> {
  log.info({ sku: input.sku, qty: input.qty }, 'оформлюємо замовлення');
  const rec = await insertOrder({ id: randomUUID(), sku: input.sku, qty: input.qty });
  log.info({ orderId: rec.id }, 'замовлення збережене');
  return rec;
}

export async function getOrder(id: string): Promise<OrderRecord> {
  log.info({ orderId: id }, 'шукаємо замовлення');
  const rec = await findOrder(id);
  log.info({ orderId: rec.id }, 'замовлення знайдене');
  return rec;
}
