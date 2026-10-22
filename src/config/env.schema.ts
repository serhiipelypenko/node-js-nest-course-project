import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

// `JWT_PREVIOUS_KID=` у скопійованому з .env.example файлі — це «не задано».
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);

// hw-24: PEM у змінній оточення їде в base64 (багаторядковий export виживає не
// в кожному середовищі). Ключ перевіряємо вже тут, у схемі: ES256 = EC P-256.
// Повідомлення НІКОЛИ не містить значення — лише імʼя змінної і причину.
const isEcKey = (kind: 'private' | 'public') => (b64: string) => {
  try {
    const pem = Buffer.from(b64, 'base64').toString('utf8');
    const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
};
const ecMessage = (kind: 'PKCS#8' | 'SPKI') =>
  `має бути base64 від PEM ${kind} ключа EC P-256 (ES256)`;

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

  // ── hw-24: автентифікація ────────────────────────────────────────────
  // 🔴 Жодних .default() для секретів: дефолт ключа підпису = ключ, зашитий у
  // код, тобто будь-хто з репозиторієм виписує токен будь-кого. Значення
  // приходять зі сховища (scripts/with-secrets.sh) або з SKIP_VAULT=1.
  JWT_PRIVATE_KEY: z.string().min(1).refine(isEcKey('private'), ecMessage('PKCS#8')),
  JWT_PUBLIC_KEY: z.string().min(1).refine(isEcKey('public'), ecMessage('SPKI')),
  // kid поточного ключа підпису: кладеться в заголовок токена і за ним
  // верифікатор вибирає ключ (overlap-ротація, див. README «Auth»).
  JWT_KID: z.string().min(1),
  // «Перець» для HMAC refresh-токенів: дамп таблиці без нього — не дамп сесій.
  REFRESH_TOKEN_PEPPER: z.string().min(8),

  // Попередній публічний ключ на час overlap-ротації — необовʼязкові,
  // але лише РАЗОМ (див. superRefine нижче).
  JWT_PREVIOUS_KID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  JWT_PREVIOUS_PUBLIC_KEY: z.preprocess(
    blankToUndefined,
    z.string().refine(isEcKey('public'), ecMessage('SPKI')).optional(),
  ),

  // Не секрети — дефолти допустимі. Орієнтир завдання: access 5–15 хв.
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(600),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(604800),
}).superRefine((env, ctx) => {
  if (Boolean(env.JWT_PREVIOUS_KID) !== Boolean(env.JWT_PREVIOUS_PUBLIC_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PREVIOUS_KID'],
      message: 'JWT_PREVIOUS_KID і JWT_PREVIOUS_PUBLIC_KEY задаються лише разом',
    });
  }
  if (env.JWT_PREVIOUS_KID && env.JWT_PREVIOUS_KID === env.JWT_KID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PREVIOUS_KID'],
      message: 'має відрізнятись від JWT_KID',
    });
  }
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
