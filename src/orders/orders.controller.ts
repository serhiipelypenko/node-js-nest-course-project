import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { filter } from 'rxjs';
import { OrderEventsService } from './order-events.service';
import { OrderItem, OrdersService, OrderStatus } from './orders.service';

interface CreateOrderBody {
  items: OrderItem[];
  buyer_id?: string;
}

interface UpdateOrderStatusBody {
  status: OrderStatus;
}

// SSE-клієнт шле retry-підказку і id/event/data-рядки.
const SSE_RETRY_MS = 1000;

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orderEvents: OrderEventsService,
  ) {}

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
    const order = this.orders.create(body.items, body.buyer_id);
    res.setHeader('Location', `/orders/${order.id}`);
    return order;
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: UpdateOrderStatusBody) {
    return this.orders.updateStatus(id, body.status);
  }

  // Не в openapi.yaml (як /health, /health/db) — express-openapi-validator
  // пропускає недокументовані маршрути (ignoreUndocumented: true), тому що
  // тіло цієї відповіді — нескінченний text/event-stream, а не JSON, який
  // можна звірити зі схемою.
  @Get(':id/events')
  events(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    // Існування замовлення перевіряємо ДО writeHead: NotFoundException звідси
    // ще встигає піти тим самим шляхом, що getOne (ProblemJsonFilter) —
    // після writeHead кидати виняток запізно, заголовки вже пішли.
    this.orders.getById(id);

    const lastEventId = Number(req.headers['last-event-id'] ?? 0);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const write = (event: { id: number; status: string; orderId: string; ts: string }) => {
      res.write(`id: ${event.id}\nevent: order.status\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Спершу пропущене з буфера (Last-Event-ID), потім живий потік.
    for (const missed of this.orderEvents.missedSince(id, lastEventId)) {
      write(missed);
    }

    const subscription = this.orderEvents.events$
      .pipe(filter((event) => event.orderId === id))
      .subscribe(write);

    req.on('close', () => subscription.unsubscribe());
  }
}
