// hw-22: relay як ОКРЕМИЙ процес — щоб demo:crash-relay міг убити його справжнім
// kill -9 рівно між publish і UPDATE published_at. Протокол з батьком (IPC):
//   ready -> published(після підтвердження брокера) -> [чекає смерті]
import 'reflect-metadata';
import { createDataSource } from '../concurrency/lib';
import { EventPublisher } from '../messaging/publisher';
import { relayOnce } from './relay';

async function main(): Promise<void> {
  const ds = createDataSource(3);
  await ds.initialize();
  const publisher = await EventPublisher.connect();
  process.send?.({ t: 'ready' });

  await relayOnce(ds, publisher, {
    hooks: {
      afterPublish: async () => {
        process.send?.({ t: 'published' });
        // вікно між (A) і (B): тут чекаємо SIGKILL, UPDATE нижче не відбудеться
        await new Promise((r) => setTimeout(r, 60_000));
      },
    },
  });
  // Дійшли сюди = нас не вбили, демо нічого не довело (батько це перевіряє).
  process.send?.({ t: 'survived' });
  await publisher.close();
  await ds.destroy();
}

main().catch((e) => {
  console.error('relay-process:', e);
  process.exit(1);
});
