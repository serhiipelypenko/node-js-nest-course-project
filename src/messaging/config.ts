// hw-19: адреса брокера — з оточення (BROKER_URL інʼєктує scripts/with-secrets.sh
// зі сховища ДЗ #11; грейдер ставить її сам при SKIP_VAULT=1). Не в
// env.schema.ts: як і DB_* data-шару, це змінна CLI/worker-шляху, а не
// HTTP-сервера. Дефолту немає навмисно — відсутня адреса має падати гучно.
export function brokerUrl(): string {
  const url = process.env.BROKER_URL;
  if (!url) {
    throw new Error(
      'BROKER_URL не задано (очікується amqp://user:pass@host:5672). ' +
        'Запускай через scripts/with-secrets.sh або з SKIP_VAULT=1 і своїм BROKER_URL.',
    );
  }
  return url;
}

// Один споживач, обробка = один INSERT у Postgres (~кілька мс).
// prefetch × час обробки = 10 × ~10 мс ≈ 0.1 с ≪ consumer_timeout (30 хв),
// і при цьому конвеєр не простоює між ack-ами (на відміну від prefetch=1).
export const PREFETCH = 10;
