// hw-23: адреси двох інстансів Redis — з оточення (REDIS_URL / REDIS_QUEUE_URL
// інʼєктує scripts/with-secrets.sh зі сховища ДЗ #11; грейдер ставить їх сам
// при SKIP_VAULT=1). Не в env.schema.ts: як DB_* і BROKER_URL, це змінні
// CLI/worker-шляху, а не HTTP-сервера. Дефолтів немає навмисно — відсутня
// адреса має падати гучно, а не мовчки йти на localhost.
function need(name: string, hint: string): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} не задано (${hint}). Запускай через scripts/with-secrets.sh ` +
        `або з SKIP_VAULT=1 і своїм ${name}.`,
    );
  }
  return url;
}

/** Інстанс-КЕШ: maxmemory + allkeys-lru, витіснення — норма. Також лічильники ліміту. */
export const cacheRedisUrl = (): string => need('REDIS_URL', 'очікується redis://host:6379');

/** Інстанс-ЧЕРГА: noeviction + AOF. BullMQ і сесії — стан, який не можна тихо втратити. */
export const queueRedisUrl = (): string =>
  need('REDIS_QUEUE_URL', 'очікується redis://host:6380');
