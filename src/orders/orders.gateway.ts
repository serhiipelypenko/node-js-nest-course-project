import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsResponse,
} from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { OrderEventsService } from './order-events.service';
import { OrdersService } from './orders.service';

export function roomForOrder(orderId: string): string {
  return `orders:${orderId}`;
}

interface JoinResult {
  ok: boolean;
  room?: string;
  reason?: 'not-found' | 'forbidden';
}

// Один provider — один транспорт (WS) над спільною шиною order-events.ts.
// Кімнати — механізм socket.io, тут
// додано лише перевірку власності на join.
@Injectable()
@WebSocketGateway()
export class OrdersGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private eventsSubscription?: Subscription;

  constructor(
    private readonly orderEvents: OrderEventsService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    // Та сама подія, що йде в SSE-буфер (OrdersService.updateStatus ->
    // OrderEventsService.emitStatusChange) — тут лише розсилаємо її в
    // кімнату ЦЬОГО замовлення, нікому іншому.
    this.eventsSubscription = this.orderEvents.events$.subscribe((event) => {
      this.server.to(roomForOrder(event.orderId)).emit('order.status', event);
    });
  }

  onModuleDestroy(): void {
    this.eventsSubscription?.unsubscribe();
  }

  // Ідентичність покупця береться з handshake (auth-payload), а не з
  // тіла join — курсовий поки без реальної авторизації (openapi.yaml:
  // "security: []"), тому це навмисно проста заглушка під майбутнє ДЗ
  // з JWT, а не крипто-перевірка.
  handleConnection(client: Socket): void {
    const buyerId = client.handshake.auth?.buyerId ?? client.handshake.query?.buyerId;
    client.data.buyerId = typeof buyerId === 'string' ? buyerId : undefined;
  }

  // Клієнт шле id замовлення; кладемо сокет у orders:<id> лише якщо
  // замовлення існує і належить buyerId з підключення — анонімному
  // (buyerId відсутній) або чужому (не збігається) відмовляємо без join.
  @SubscribeMessage('join')
  join(@ConnectedSocket() client: Socket, @MessageBody() orderId: string): WsResponse<JoinResult> {
    let ownerId: string;
    try {
      ownerId = this.orders.getById(orderId).buyer_id;
    } catch {
      return { event: 'joined', data: { ok: false, reason: 'not-found' } };
    }

    const buyerId = client.data.buyerId as string | undefined;
    if (!buyerId || buyerId !== ownerId) {
      return { event: 'joined', data: { ok: false, reason: 'forbidden' } };
    }

    const room = roomForOrder(orderId);
    void client.join(room);
    return { event: 'joined', data: { ok: true, room } };
  }
}
