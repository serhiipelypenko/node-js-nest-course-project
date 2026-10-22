import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validate } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';

@Module({
  imports: [
    // validate виконується ТУТ, до побудови DI-графа. Зламана змінна —
    // виняток, який ловить bootstrap().catch() у main.ts і робить exit(1).
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
