// hw-28: сервіс курсового Marketplace у Kubernetes.
//
// Це «k8s-обличчя» курсового: той самий домен, але лише те, що потрібно, щоб
// довести викочування без втрат. Нестівський моноліт (src/) тягне Postgres,
// Redis, RabbitMQ, S3 і ключі JWT — у одновузловий kind усе це не влізе, а
// критерії ДЗ дивляться на ПОВЕДІНКУ процесу: /healthz, /readyz, прогрів до
// listen() і порядок «спершу не готовий — потім закрив сокет».
//
// Жодних залежностей: node:http. Нема що ставити з реєстру в рантаймі.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
// Імітація міграцій і прогріву пулу БД. Поки слухача нема, запит отримує
// «connection refused» — саме це робить вимір викочування НЕпорожнім.
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 4000);
// Скільки тримаємо сокет відкритим після «я більше не готовий».
const DRAIN_MS = Number(process.env.DRAIN_MS ?? 5000);
// GRACEFUL=0 — профіль «як не треба»: обробника SIGTERM немає зовсім.
const GRACEFUL = (process.env.GRACEFUL ?? '1') === '1';
const REV = process.env.REV ?? '0';

// Секрет рантайму приїжджає з K8s Secret (secretKeyRef). Падаємо голосно й
// називаємо змінну; саме значення не логуємо і не віддаємо — лише довжину.
const DB_PASSWORD = process.env.APP_DB_PASSWORD;
if (!DB_PASSWORD) {
  console.error('[fatal] не задано APP_DB_PASSWORD (має приїхати з K8s Secret)');
  process.exit(1);
}

let ready = false;
let shuttingDown = false;

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const send = (code: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  // Питання «чи треба мене вбити»: 200, поки процес живий.
  if (path === '/healthz') return send(200, { alive: true, pid: process.pid });

  // Питання «чи можна слати трафік»: інше питання, інша відповідь.
  if (path === '/readyz') {
    return ready ? send(200, { ready: true }) : send(503, { ready: false, shuttingDown });
  }

  return send(200, {
    service: 'marketplace',
    rev: REV,
    host: process.env.HOSTNAME ?? 'unknown',
    uid: process.getuid?.() ?? -1,
    db_password_len: DB_PASSWORD.length,
  });
});

async function main(): Promise<void> {
  console.log(`[warmup] ${WARMUP_MS} мс — слухача ще немає`);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  await new Promise<void>((r) => server.listen(PORT, '0.0.0.0', r));
  ready = true;
  console.log(`[up] :${PORT} uid=${process.getuid?.()} rev=${REV} graceful=${GRACEFUL} drain=${DRAIN_MS}мс`);
}

if (GRACEFUL) {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // 1. Спершу перестаємо казати «я готовий». readinessProbe падає,
      //    EndpointSlice прибирає наш IP.
      ready = false;
      console.log(`[${sig}] ready=false, дренаж ${DRAIN_MS} мс`);
      // 2. Лише потім, після паузи, закриваємо сокет. close() одразу — це
      //    відмова новим зʼєднанням, поки балансувальник ще шле трафік.
      setTimeout(() => {
        server.close(() => {
          console.log('[bye] сокет закрито, вихід 0');
          process.exit(0);
        });
        server.closeIdleConnections();
        // страховка: активні зʼєднання не мають тримати вихід вічно
        setTimeout(() => process.exit(0), 2000).unref();
      }, DRAIN_MS);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
