import { z } from 'zod';

// Єдина точка правди про конфігурацію застосунку.
//
// Усе, що приходить з середовища, — рядок. Тому числа/булеві значення
// описуємо через z.coerce.*, інакше z.number() впаде на рядку "3000".
export const envSchema = z.object({
  // Режим роботи. За замовчуванням — development, щоб локальний запуск
  // без .env не падав тільки через відсутність цієї змінної.
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Порт HTTP-сервера.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // DSN Postgres БЕЗ пароля: host/port/db/user беруться звідси, а пароль
  // читається окремо з файла (DB_PASSWORD_FILE) на кожне нове зʼєднання.
  DB_URL: z.string().url(),

  // Шлях до файла-секрета з паролем ролі БД. У git/образ не потрапляє.
  DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),
});

export type Env = z.infer<typeof envSchema>;

// validate викликається всередині ConfigModule.forRoot({ validate }) ДО
// побудови DI-графа. На помилці кидаємо ОДИН Error зі списком УСІХ зламаних
// змінних одразу (а не по одній) — щоб з першого запуску було видно все,
// що треба полагодити. bootstrap().catch() у main.ts надрукує message і
// зробить process.exit(1).
export function validate(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => {
      const name = issue.path.join('.') || '(корінь)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');

  throw new Error(
    `Некоректна конфігурація середовища — застосунок не стартує:\n${details}`,
  );
}
