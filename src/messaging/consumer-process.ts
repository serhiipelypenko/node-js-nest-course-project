// hw-19: споживач як ОКРЕМИЙ процес — щоб demo:duplicate міг його вбити
// SIGKILL-ом. channel.close() — коректне завершення; падіння сервісу в проді
// виглядає як зникнення процесу й обрив сокета.
// Протокол з батьком (process.send): ready | recv | effect | skip | acked.
import 'reflect-metadata';
import { createDataSource } from '../concurrency/lib';
import { startConsumer } from './consumer';

const send = (m: Record<string, unknown>) => process.send?.(m);

async function main(): Promise<void> {
  const ds = createDataSource(5);
  await ds.initialize();
  const consumer = await startConsumer({
    dataSource: ds,
    gapMs: Number(process.env.CONSUMER_GAP_MS ?? 0),
    hooks: {
      onRecv: (m) => send({ t: 'recv', id: m.eventId, redelivered: m.redelivered }),
      onEffect: (id) => send({ t: 'effect', id }),
      onSkip: (id) => send({ t: 'skip', id }),
      onAcked: (id) => send({ t: 'acked', id }),
      onCancel: () => process.exit(1),
    },
  });
  send({ t: 'ready' });

  process.on('message', async (m: { t?: string }) => {
    if (m?.t === 'stop') {
      await consumer.close();
      await ds.destroy();
      process.exit(0);
    }
  });
}

main().catch((e) => {
  console.error('consumer-process:', e);
  process.exit(1);
});
