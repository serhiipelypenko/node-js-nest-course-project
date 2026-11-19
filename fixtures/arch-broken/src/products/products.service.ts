// Фікстура demo:gates: ЗАБОРОНЕНИЙ імпорт products -> orders (правило products-not-to-orders) і цикл.
import { priceOrder } from '../orders/orders.service';

export const listProducts = (): number[] => [priceOrder()];
