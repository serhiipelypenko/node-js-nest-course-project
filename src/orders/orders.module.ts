import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { OrderEventsService } from './order-events.service';
import { OrdersController } from './orders.controller';
import { OrdersGateway } from './orders.gateway';
import { OrdersService } from './orders.service';

@Module({
  imports: [ProductsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderEventsService, OrdersGateway],
})
export class OrdersModule {}
