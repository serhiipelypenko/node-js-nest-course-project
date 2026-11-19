// Фікстура demo:gates: «правильна» сторона залежності (orders -> products дозволено).
import { listProducts } from '../products/products.service';

export const priceOrder = (): number => listProducts().length;
