// OTel — ПЕРШИМ імпортом: до того, як будь-що підтягне `http`.
import './observability/otel';
import { close, createObsServer, listen } from './observability/app';
import { flushTelemetry, shutdownTelemetry } from './observability/otel';
import { rootLogger } from './observability/logger';

// Автономний запуск сервісу для ручного огляду дашборда: `npm run obs:serve`, далі ганяєш трафік curl-ом.
async function main() {
  const port = Number(process.env.OBS_APP_PORT ?? 22900);
  const server = createObsServer();
  await listen(server, port);
  rootLogger.info({ port }, 'obs-сервіс слухає');
  const stop = async () => {
    await close(server);
    await flushTelemetry();
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
