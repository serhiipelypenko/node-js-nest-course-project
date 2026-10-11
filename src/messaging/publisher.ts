// hw-19: публікація з confirm-каналом. «Опублікував» = брокер взяв на себе
// відповідальність (waitForConfirms), а не «віддав у сокет».
// Топологію продюсер НЕ оголошує — це робить бутстрап/споживач.
import * as amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { brokerUrl } from './config';
import { EXCHANGE, ROUTING_KEY_ORDER_PLACED } from './topology';
import type { OrderPlacedEvent } from './events';

export class EventPublisher {
  /** Скільки повідомлень брокер повернув як unroutable (mandatory + basic.return). */
  returned = 0;

  private constructor(
    private readonly conn: ChannelModel,
    private readonly ch: ConfirmChannel,
  ) {
    ch.on('return', () => {
      this.returned += 1;
    });
  }

  static async connect(): Promise<EventPublisher> {
    const conn = await amqp.connect(brokerUrl());
    const ch = await conn.createConfirmChannel();
    return new EventPublisher(conn, ch);
  }

  async publishOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    await this.publishRaw(ROUTING_KEY_ORDER_PLACED, Buffer.from(JSON.stringify(event)), {
      messageId: event.eventId,
      type: event.type,
    });
  }

  /** Сирі байти — для демо отруєного повідомлення (валідний контракт так не зламати). */
  async publishRaw(
    routingKey: string,
    content: Buffer,
    props: { messageId?: string; type?: string } = {},
  ): Promise<void> {
    this.ch.publish(
      EXCHANGE,
      routingKey,
      content,
      { persistent: true, contentType: 'application/json', mandatory: true, ...props },
      // Кожна публікація чекає на ack брокера нижче; помилки nack приходять тут.
      () => undefined,
    );
    await this.ch.waitForConfirms();
  }

  async close(): Promise<void> {
    await this.ch.close().catch(() => undefined);
    await this.conn.close().catch(() => undefined);
  }
}
