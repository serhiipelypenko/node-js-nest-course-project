// OpenTelemetry. 🔴 Цей модуль має бути ПЕРШИМ імпортом точки входу (або `node -r`): інакше
// `http` уже завантажений без патча, автоінструментуванню нема що перехоплювати — і спанів немає,
// і помилки теж немає.
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'marketplace-orders';

// Дзеркало спанів у памʼяті: демо рахують спани САМІ, а не покладаються на те, що бек уже їх проіндексував.
// Simple-процесор експортує на span.end() синхронно; Batch (OTLP) — раз на кілька секунд, тому нижче forceFlush().
export const memorySpans = new InMemorySpanExporter();

// Адреса приймача — зі сховища (with-secrets.sh) або з export при SKIP_VAULT=1. Не задана — спани лишаються
// лише в памʼяті (demo:logs / demo:metrics цього не потребують).
const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const processors: SpanProcessor[] = [new SimpleSpanProcessor(memorySpans)];
if (OTLP) {
  processors.push(
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${OTLP.replace(/\/$/, '')}/v1/traces` }), {
      scheduledDelayMillis: 1000,
    }),
  );
}

export const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
  spanProcessors: processors,
});
// register() ставить контекст-менеджер на AsyncLocalStorage і W3C Trace Context-пропагатор:
// вхідний `traceparent` ПРОДОВЖУЄТЬСЯ, а не губиться.
provider.register();

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      // службові шляхи не мають засмічувати трейси (і RED): скрейпи Prometheus кожні 2 с.
      ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/health',
      // Authorization не має їхати в атрибути спана; HttpInstrumentation їх і так не збирає без явного
      // headersToSpanAttributes — лишаємо як є.
    }),
  ],
});

export const tracer = trace.getTracer('marketplace.orders');

// 🔴 Батчевий експортер шле не одразу: на виході (і перед читанням бекенду) — forceFlush().
export async function flushTelemetry(): Promise<void> {
  await provider.forceFlush();
}

export async function shutdownTelemetry(): Promise<void> {
  await provider.shutdown();
}
