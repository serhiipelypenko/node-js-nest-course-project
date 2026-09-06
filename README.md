# Marketplace API — курсовий проєкт

- **hw-09** — OpenAPI-контракт + рантайм-валідація на кордоні (варіант **Б**).
- **hw-11** — конфіг-скелет: `process.env` → zod-схема (fail-fast) → `ConfigService`,
  секрети поза git і поза docker-образом, ротація пароля БД без рестарту
  (див. розділ [Configuration](#configuration)).

Обраний варіант hw-09: **Б — runtime-валідація на кордоні**.

Стек: NestJS (`@nestjs/core`, `@nestjs/platform-express`) + `express-openapi-validator`,
який валідує кожен запит і кожну відповідь проти `openapi/openapi.yaml`
(`validateRequests: true`, `validateResponses: true`). Помилки валідатора та
винятки контролерів перекладаються в `problem+json` (спільний білдер
`src/common/problem.ts`, використаний і Nest `ExceptionFilter`, і
express-обробником помилок валідатора — деталі нижче) — жодних ручних `if`
для перевірки заголовка чи тіла запиту немає, все це робить спека.

## Структура

```
openapi/openapi.yaml    — контракт: 2 ресурси (products, orders), 5 операцій
scripts/check-spec.cjs  — перевірка обсягу спеки (операції/ресурси/Idempotency-Key)
src/
  main.ts                     — bootstrap: підключення express-openapi-validator
                                 як express-мідлвара (validateRequests + validateResponses)
  app.module.ts               — кореневий модуль (ProductsModule + OrdersModule)
  common/
    problem.ts                  — спільний білдер тіла problem+json
    problem-json.filter.ts      — Nest ExceptionFilter: помилки з контролерів
    problem-json.middleware.ts  — express error-handler: помилки самого валідатора
    cursor.ts                   — opaque-курсор (base64url від offset)
  products/                   — GET /products, GET /products/{id}
  orders/                     — GET /orders, GET /orders/{id}, POST /orders
```

Дані — in-memory (масиви в сервісах), без БД.

Чому два обробники помилок, а не один. `express-openapi-validator` валідує
запит/відповідь ще на рівні звичайного express-мідлвара — ДО того, як
керування доходить до Nest-роутера, тож його помилки `next(err)` Nest
`ExceptionFilter` не бачить (`problem-json.middleware.ts`). Винятки, кинуті
вже всередині контролерів (наприклад, `NotFoundException` на неіснуючому
id), навпаки, ловить саме Nest-фільтр (`problem-json.filter.ts`). Обидва
формують однакове тіло через спільний `writeProblem` з `problem.ts`.

## Встановлення

```bash
npm install
```

## Запуск

```bash
cp .env.example .env                              # локальні змінні (у .gitignore)
mkdir -p secrets && printf '%s' dev_secret_pw > secrets/db_password
docker compose up -d db                           # локальний Postgres
npm start                                         # = npm run build && node dist/main.js
# або для розробки: npm run start:dev
```

Сервер піднімається на `http://localhost:3000` (порт береться зі схеми конфіга).

---

## Configuration

### Змінні середовища

Джерело правди — zod-схема `src/config/env.schema.ts`. Контракт для людей —
`.env.example` (у git; реальний `.env` — у `.gitignore`). `npm run check:env`
звіряє їх і падає з `exit 1`, якщо файл відстав від схеми.

| Змінна             | Тип / формат                         | Обовʼязкова | Дефолт                    | Призначення |
|--------------------|--------------------------------------|-------------|---------------------------|-------------|
| `NODE_ENV`         | `development \| production \| test`  | ні          | `development`             | режим роботи |
| `PORT`             | ціле 1–65535                         | ні          | `3000`                    | порт HTTP-сервера |
| `DB_URL`           | URL `postgres://user@host:port/db`   | **так**     | —                         | DSN Postgres **без пароля** |
| `DB_PASSWORD_FILE` | шлях до файла                        | ні          | `./secrets/db_password`   | файл із паролем ролі БД |

Пароль БД — **не змінна середовища, а файл**. `src/database/database.module.ts`
передає в `pg.Pool` поле `password` як `async`-функцію, що перечитує цей файл на
**кожне нове зʼєднання**. Це і робить ротацію без рестарту можливою.

Зламана/відсутня обовʼязкова змінна = `validate()` кидає `Error` зі списком усіх
проблем одразу → `bootstrap().catch()` у `main.ts` друкує причину і робить
`process.exit(1)`. Процес не стартує — помилка видно на старті, а не на першому
запиті в проді.

### Секрети поза git і поза образом

- `.gitignore`: `.env`, `secrets/` (у git лежить лише `.env.example`).
- `.dockerignore`: `.env`, `.env.*`, `secrets/` (у образ потрапляє лише `.env.example`).
- `Dockerfile` (runner-стадія) **не задає жодного `ENV`** — `docker inspect` показує
  тільки змінні базового образу.

### Ротація пароля БД без рестарту

```bash
# 0. Постгрес і застосунок працюють
docker compose up -d db
npm start                                   # окремий термінал
curl -s localhost:3000/health               # запамʼятай uptime_seconds і pid
curl -s localhost:3000/health/db            # -> {"db":"ok"}

# 1. Ротація
bash rotate.sh
#   1/3  ALTER ROLE marketplace WITH PASSWORD '<new>'   — БД знає новий пароль
#   2/3  printf '%s' '<new>' > secrets/db_password       — файл-секрет оновлено (той самий inode)
#   3/3  SELECT pg_terminate_backend(...) для ролі       — старі зʼєднання розірвано

# 2. Перевірка: сервіс живий, процес той самий
curl -s localhost:3000/health/db            # -> {"db":"ok"} (нове зʼєднання, новий пароль з файла)
curl -s localhost:3000/health               # uptime_seconds БІЛЬШИЙ, pid ТОЙ САМИЙ
```

Чому працює: `pg.Pool` викликає `password: async () => readFile(...)` на кожне нове
зʼєднання; крок 3 рве старі конекти, пул відкриває нові — вже з новим паролем із
файла. `pool.on('error')` у `database.module.ts` гасить подію від розірваних
idle-зʼєднань, інакше процес би впав.

### Запуск усього в Docker

```bash
docker compose up --build        # db + api; api читає /run/secrets/db_password (bind-mount)
```

## Перевірка спеки (acceptance criteria, пункти 1-4)

```bash
# Спека валідна (exit 0, warnings дозволені)
npx @redocly/cli lint openapi/openapi.yaml

# Обсяг спеки: >=2 ресурси, >=5 операцій, Idempotency-Key required + опис >=40 символів
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node scripts/check-spec.cjs
# або одним викликом:
npm run check:spec

# Ключові маркери в тексті спеки
grep -c 'Idempotency-Key' openapi/openapi.yaml            # >= 1
grep -c 'next_cursor' openapi/openapi.yaml                 # >= 1
grep -c 'application/problem+json' openapi/openapi.yaml    # >= 2
```

## Перевірка застосунку (acceptance criteria, варіант Б)

Після `npm start`:

```bash
# Без Idempotency-Key -> 400 + application/problem+json
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"p1","quantity":2}]}'

# Порожній items -> 400, деталь від валідатора
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: key-1' \
  -d '{"items":[]}'

# Валідний запит -> 201
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: key-1' \
  -d '{"items":[{"product_id":"p1","quantity":2}]}'

# Список товарів з cursor-пагінацією
curl -s "http://localhost:3000/products?limit=2"

# 404 у форматі problem+json
curl -i http://localhost:3000/products/does-not-exist
```

Очікувані `detail` від валідатора:

- `request/headers must have required property 'idempotency-key'`
- `request/body/items must NOT have fewer than 1 items`

## Docker

Див. розділ [Configuration → Запуск усього в Docker](#запуск-усього-в-docker).