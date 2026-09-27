import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export interface OrderStatusEvent {
  // Порядковий номер У МЕЖАХ ЦЬОГО замовлення (не глобальний) — саме його
  // SSE-контролер пише в `id:` і саме за ним рахує Last-Event-ID.
  id: number;
  orderId: string;
  status: string;
  ts: string;
}

// Скільки останніх подій на замовлення тримаємо для догравання після
// Last-Event-ID — того самого буфера, що й у лекційному кроці 3.
const BUFFER_SIZE = 100;

// Спільна шина подій для WS-gateway і SSE-контролера.
// Сама по собі нічого не знає про socket.io чи HTTP —
// лише RxJS Subject (гарячий, мультикастить усім підписникам одразу) плюс
// буфер на випадок реконекту SSE-клієнта.
@Injectable()
export class OrderEventsService {
  private readonly bus = new Subject<OrderStatusEvent>();
  private readonly buffers = new Map<string, OrderStatusEvent[]>();
  private readonly counters = new Map<string, number>();

  readonly events$: Observable<OrderStatusEvent> = this.bus.asObservable();

  emitStatusChange(orderId: string, status: string): OrderStatusEvent {
    const nextId = (this.counters.get(orderId) ?? 0) + 1;
    this.counters.set(orderId, nextId);

    const event: OrderStatusEvent = {
      id: nextId,
      orderId,
      status,
      ts: new Date().toISOString(),
    };

    const buffer = this.buffers.get(orderId) ?? [];
    buffer.push(event);
    if (buffer.length > BUFFER_SIZE) buffer.shift();
    this.buffers.set(orderId, buffer);

    this.bus.next(event);
    return event;
  }

  // Події конкретного замовлення з id > lastEventId — те, що SSE-клієнт
  // пропустив, поки був відключений.
  missedSince(orderId: string, lastEventId: number): OrderStatusEvent[] {
    return (this.buffers.get(orderId) ?? []).filter((e) => e.id > lastEventId);
  }
}
