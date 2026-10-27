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
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
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
    private readonly auth: AuthService,
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

  // hw-24: ідентичність — з access-токена в handshake (`io(url, { auth: { token } })`),
  // перевіреного так само, як і в HTTP (підпис, exp, денилист). Заглушка
  // `buyerId` з hw-18 прибрана: клієнт міг назвати себе ким завгодно. Без
  // валідного токена сокет лишається анонімним і в жодну кімнату не потрапить.
  handleConnection(client: Socket): void {
    const token = client.handshake.auth?.token;
    // Зберігаємо ПРОМІС: перший `join` може прилетіти раніше, ніж завершиться
    // запит у денилист, і не має отримати «forbidden» через гонку.
    client.data.user = (
      typeof token === 'string'
        ? this.auth.authenticate(token).catch(() => undefined)
        : Promise.resolve(undefined)
    ) as Promise<AuthUser | undefined>;
  }

  // Клієнт шле id замовлення; кладемо сокет у orders:<id> лише якщо
  // замовлення існує і належить buyerId з підключення — анонімному
  // (buyerId відсутній) або чужому (не збігається) відмовляємо без join.
  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() orderId: string,
  ): Promise<WsResponse<JoinResult>> {
    const user = await (client.data.user as Promise<AuthUser | undefined>);
    let ownerId: string;
    try {
      ownerId = this.orders.getById(orderId).buyer_id;
    } catch {
      return { event: 'joined', data: { ok: false, reason: 'not-found' } };
    }

    if (!user || (user.id !== ownerId && user.role !== 'admin')) {
      return { event: 'joined', data: { ok: false, reason: 'forbidden' } };
    }

    const room = roomForOrder(orderId);
    void client.join(room);
    return { event: 'joined', data: { ok: true, room } };
  }
}
