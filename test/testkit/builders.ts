import { DataSource } from 'typeorm';
import { User } from '../../src/entities/user.entity';
import { Product } from '../../src/entities/product.entity';
import { Order, OrderStatus } from '../../src/entities/order.entity';
import { OrderItem } from '../../src/entities/order-item.entity';

let seq = 0;

/** Test data builder: у тесті звучить лише поле під перевірку; решта — валідні унікальні дефолти. */
export class UserBuilder {
  private email = `user-${++seq}@example.com`;
  private fullName = 'Тестовий Користувач';
  private balance = 1_000_000;

  withEmail(email: string): this {
    this.email = email;
    return this;
  }

  withFullName(fullName: string): this {
    this.fullName = fullName;
    return this;
  }

  withBalance(balance: number): this {
    this.balance = balance;
    return this;
  }

  build(): Partial<User> {
    return { email: this.email, fullName: this.fullName, balance: this.balance };
  }

  async insertVia(dataSource: DataSource): Promise<User> {
    return dataSource.getRepository(User).save(this.build());
  }
}

export const aUser = () => new UserBuilder();

export class ProductBuilder {
  private sku = `sku-${++seq}`;
  private name = 'Тестовий товар';
  private price = 100;
  private stock = 10;

  withSku(sku: string): this {
    this.sku = sku;
    return this;
  }

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withPrice(price: number): this {
    this.price = price;
    return this;
  }

  withStock(stock: number): this {
    this.stock = stock;
    return this;
  }

  build(): Partial<Product> {
    return { sku: this.sku, name: this.name, price: this.price, stock: this.stock };
  }

  async insertVia(dataSource: DataSource): Promise<Product> {
    return dataSource.getRepository(Product).save(this.build());
  }
}

export const aProduct = () => new ProductBuilder();

interface OrderLine {
  product: Product;
  quantity: number;
  unitPrice: number;
}

/**
 * Замовлення з позиціями. Якщо покупця/товар не задали явно — будівник сам
 * створює валідного (через aUser()/aProduct()), щоб у тесті лишалось на
 * виду тільки те поле, яке тест перевіряє.
 */
export class OrderBuilder {
  private buyer: User | null = null;
  private status: OrderStatus = 'pending';
  private lines: OrderLine[] = [];

  withBuyer(buyer: User): this {
    this.buyer = buyer;
    return this;
  }

  withStatus(status: OrderStatus): this {
    this.status = status;
    return this;
  }

  withItem(product: Product, quantity = 1, unitPrice = product.price): this {
    this.lines.push({ product, quantity, unitPrice });
    return this;
  }

  async insertVia(dataSource: DataSource): Promise<Order> {
    const buyer = this.buyer ?? (await aUser().insertVia(dataSource));
    const lines = this.lines.length
      ? this.lines
      : [{ product: await aProduct().insertVia(dataSource), quantity: 1, unitPrice: 10 }];
    const totalAmount = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);

    const order = await dataSource.getRepository(Order).save({
      buyer,
      customerEmail: buyer.email,
      status: this.status,
      totalAmount,
    });

    const itemRepo = dataSource.getRepository(OrderItem);
    for (const line of lines) {
      await itemRepo.save({
        order,
        product: line.product,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      });
    }

    return order;
  }
}

export const anOrder = () => new OrderBuilder();
