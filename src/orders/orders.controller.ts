import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OrderItem, OrdersService } from './orders.service';

interface CreateOrderBody {
  items: OrderItem[];
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.list(limit, cursor);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.orders.getById(id);
  }

  // Заголовок Idempotency-Key і форма тіла (items, мінімум 1) вимагаються
  // й перевіряються спекою через express-openapi-validator — тут навмисно
  // немає жодного ручного `if` на цей рахунок.
  @Post()
  @HttpCode(201)
  create(@Body() body: CreateOrderBody, @Res({ passthrough: true }) res: Response) {
    const order = this.orders.create(body.items);
    res.setHeader('Location', `/orders/${order.id}`);
    return order;
  }
}
