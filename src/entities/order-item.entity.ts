import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationId,
} from 'typeorm';
import { numericTransformer } from './numeric.transformer';
import { Order } from './order.entity';
import { Product } from './product.entity';

// Явна join-entity Order <-> Product: на самому зв'язку живуть дані
// (quantity, unitPrice — ціна на момент покупки), тому це НЕ @ManyToMany.
@Entity('order_items')
@Check('"quantity" > 0')
@Check('"unit_price" >= 0')
export class OrderItem {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  // Видалили замовлення -> позиції не мають сенсу без нього -> CASCADE.
  @ManyToOne(() => Order, (order) => order.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  // @RelationId — сире значення FK у SELECT без JOIN на order. Потрібне
  // demo-nplus1.ts, щоб змоделювати реалістичний наївний код: "піти по
  // ідентифікатору в циклі", а не мати relation вже підвантаженим.
  @RelationId((item: OrderItem) => item.order)
  orderId: string;

  // Видалити товар, на який уже є продажі, — заборонено -> RESTRICT.
  @ManyToOne(() => Product, (product) => product.orderItems, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @RelationId((item: OrderItem) => item.product)
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  // Історична ціна: НЕ product.price, а ціна на момент покупки.
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    name: 'unit_price',
    transformer: numericTransformer,
  })
  unitPrice: number;
}
