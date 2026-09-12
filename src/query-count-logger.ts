import { AbstractLogger, LogLevel, LogMessage } from 'typeorm';

// N+1 не видно в коді — тільки в лозі SQL. Цей Logger рахує реальні
// запити до Postgres, не рядки коду; вмикати echo варто лише під час
// самого демо, щоб seed/report не шуміли в консоль.
export class QueryCountLogger extends AbstractLogger {
  count = 0;
  echo = false;

  reset(): void {
    this.count = 0;
  }

  protected writeLog(
    _level: LogLevel,
    messages: LogMessage | LogMessage[],
  ): void {
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (m.type === 'query') {
        this.count += 1;
        if (this.echo) {
          console.log(`  SQL#${this.count}: ${String(m.message).slice(0, 120)}`);
        }
      }
    }
  }
}
