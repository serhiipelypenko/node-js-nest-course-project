# Marketplace API — курсовий проєкт

- **hw-09** — OpenAPI-контракт + рантайм-валідація на кордоні (варіант **Б**).
- **hw-11** — конфіг-скелет: `process.env` → zod-схема (fail-fast) → `ConfigService`,
  секрети поза git і поза docker-образом, ротація пароля БД без рестарту
  (див. розділ [Configuration](#configuration)).
- **hw-12** — дата-шар: схема (`db/schema.sql`), seed на 300k рядків
  (`db/seed.sql`), три повільні запити + індекси, що їх лікують, і звіт
  EXPLAIN до/після (див. розділ [Дата-шар (hw-12)](#дата-шар-hw-12)).
- **hw-13** — ORM: entities/relations/міграції для схеми з hw-12 через
  TypeORM (`synchronize: false`), детермінований ідемпотентний seed, живе
  демо N+1 «до/після» і звіт через `createQueryBuilder().getRawMany()`
  (див. розділ [ORM-шар (hw-13)](#orm-шар-hw-13)).
- **hw-14** — транзакційний checkout (декремент stock + списання балансу +
  INSERT замовлення + INSERT задачі на post-processing, усе в одній
  транзакції, без oversell при 50+ паралельних викликах), воркер-пул через
  `FOR UPDATE SKIP LOCKED` і retry-патерн на `40001`/`40P01` під
  REPEATABLE READ (див. розділ [Конкурентність (hw-14)](#конкурентність-hw-14)).
- **hw-15** — PgBouncer (transaction mode) перед Postgres, `scripts/backup.sh`
  (`pg_dump -Fc` з датою в імені + `backup.cron`) і `scripts/restore-drill.sh`
  (відновлення в чистий контейнер + звірка → `MATCH`, результат — у
  [RESTORE-DRILL.md](RESTORE-DRILL.md); див. розділ
  [Пулер зʼєднань і бекапи (hw-15)](#пулер-зʼєднань-і-бекапи-hw-15)).
- **hw-16** — драбинка довіри над тестами: integration suite на
  testcontainers (репозиторії TypeORM проти справжнього Postgres), E2E
  головної фічі через supertest, contract-тест через Pact із брокером і
  `can-i-deploy` у CI (див. розділ [Тестування (hw-16)](#тестування-hw-16)).
- **hw-18** — realtime-шар: WebSocket-gateway (socket.io, кімнати `orders:<id>`
  з перевіркою власності) і SSE (`GET /orders/{id}/events`, `Last-Event-ID`)
  над спільною шиною подій, headless-демо ізоляції кімнат
  (`scripts/realtime-demo.mjs`) (див. розділ
  [Realtime-шар (hw-18)](#realtime-шар-hw-18)).
- **hw-19** — async-події через RabbitMQ: `order.placed` із транзакційного
  `checkout()` (confirm-канал), споживач із ручним ack і явним prefetch, DLQ як
  окремий контур, ідемпотентний ефект у Postgres (`ON CONFLICT DO NOTHING`);
  три демо `demo:publish` / `demo:dlq` / `demo:duplicate` (див. розділ
  [Async-події через RabbitMQ](#async-події-через-rabbitmq)).
- **hw-20** — імплементація outbox паттерну у NestJS, ідемпотентність у Postgres
  (`ON CONFLICT DO NOTHING`), ізольовані транзакції у RabbitMQ (див. розділ
  [Outbox та ідемпотентність](#outbox-та-ідемпотентність)).

- **hw-23** — Redis: cache-aside з TTL+джитером і single-flight локом проти
  stampede, сесії з rolling TTL, rate-limit (ковзне вікно) на спільному сховищі,
  черга BullMQ (retry/backoff, дедуплікація за `jobId`, `upsertJobScheduler`) на
  окремому Redis із `noeviction`; чотири демо `demo:cache` / `demo:session` /
  `demo:ratelimit` / `demo:queue` (див. розділ
  [Redis: кеш, сесії, ліміти, черга](#redis-кеш-сесії-ліміти-черга)).

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
openapi/openapi.yaml    — контракт: 2 ресурси (products, orders), 6 операцій
scripts/check-spec.cjs  — перевірка обсягу спеки (операції/ресурси/Idempotency-Key)
scripts/realtime-demo.mjs — headless-демо ізоляції WS-кімнат (hw-18)
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
  orders/                     — GET /orders, GET /orders/{id}, POST /orders,
                                 PATCH /orders/{id}/status, GET /orders/{id}/events (SSE)
    order-events.service.ts     — спільна шина подій (RxJS Subject) + буфер
                                   останніх подій на замовлення (hw-18)
    orders.gateway.ts            — WebSocket-gateway: join, кімната orders:<id>,
                                   перевірка власника замовлення (hw-18)
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
cp secrets/db_password.example secrets/db_password # файл-секрет (у .gitignore)
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

| Змінна             | Тип / формат                         | Обовʼязкова | Дефолт                    | Джерело значення | Призначення |
|--------------------|--------------------------------------|-------------|---------------------------|------------------|-------------|
| `NODE_ENV`         | `development \| production \| test`  | ні          | `development`             | `.env` / оточення процесу | режим роботи |
| `PORT`             | ціле 1–65535                         | ні          | `3000`                    | `.env` / оточення процесу | порт HTTP-сервера |
| `DB_URL`           | URL `postgres://user@host:port/db`   | **так**     | —                         | **сховище конфігурації (hw-11)** — оточення `dev` і `prod`; у git лише фейковий рядок у `.env.example` | DSN Postgres до бази hw-12 **без пароля** |
| `DB_PASSWORD_FILE` | шлях до файла                        | ні          | `./secrets/db_password`   | `.env` / оточення процесу (сам пароль — у файлі-секреті, не в git) | файл із паролем ролі БД |

`DB_URL` — це та сама змінна з hw-11; для hw-12 змінилося лише **значення**:
воно вказує на базу цього ДЗ. З hw-15 хост/порт у ній — PgBouncer (`6432`), а не прямий Postgres. Нового env-файла з рядком підключення не
зʼявилося — джерело правди для `dev`/`prod` — сховище конфігурації, а
`.env.example` містить лише зразок із фейковим паролем.

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

## Дата-шар (hw-12)

Схема, seed і докази швидкості під обсягом. Головна таблиця — **`orders`**
(300 000 рядків). Усі файли — у `db/`:

| Файл | Призначення |
|------|-------------|
| `db/schema.sql` | 4 таблиці (`users`, `products`, `orders`, `order_items`), 3 FOREIGN KEY, `CHECK`, `numeric`/`timestamptz` |
| `db/seed.sql` | генерація даних через `generate_series` (300k `orders`), перекошені розподіли, у кінці `VACUUM (ANALYZE)` |
| `db/queries/q1.sql` … `q3.sql` | по одному реальному запиту API на файл |
| `db/indexes.sql` | 3 індекси (складений + partial + expression), що лікують усі три запити |
| `db/OPTIMIZATIONS.md` | EXPLAIN (ANALYZE, BUFFERS) до/після для кожного запиту + пояснення |

### Підняти Postgres (працює на свіжому клоні, без правок файлів)

```bash
docker compose up -d db --wait
```

Дев-креденшели стенду зафіксовані в `docker-compose.yml` + `scripts/init.sql`
(роль `marketplace` / пароль `dev_secret_pw` / база `marketplace`). Це окремий
шлях від застосунку: сервіс бере `DB_URL` зі сховища конфігурації, а цей
локальний стенд потрібен грейдеру для чистого клону.

### Підключитись (psql)

```bash
docker compose exec db psql -U marketplace -d marketplace
```

Це інтерактивний сеанс (`marketplace=#`), вихід — `\q` або `Ctrl+D`. Прапорець
`-T` тут НЕ потрібен: він вимикає термінал і має сенс лише разом із `-c`/`-f`
(див. «Прогнати всі кроки»), інакше psql просто мовчки чекає stdin.

`./db` змонтовано в контейнер як `/db` (read-only), тож `-f /db/schema.sql`
працює без host-клієнта. Якщо psql є на хості — рівнозначно:
`psql "postgresql://marketplace:dev_secret_pw@localhost:5432/marketplace"`.

### Прогнати всі кроки

```bash
PSQL='docker compose exec -T db psql -U marketplace -d marketplace'

# 1. схема на чисту базу
$PSQL -f /db/schema.sql

# 2. seed (~13 c) — 300k рядків у orders, у кінці VACUUM (ANALYZE)
$PSQL -f /db/seed.sql

# 3. EXPLAIN «до» — кожен запит дає Seq Scan
for q in q1 q2 q3; do $PSQL -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"; done

# 4. індекси + свіжа статистика
$PSQL -f /db/indexes.sql
$PSQL -c "ANALYZE;"

# 5. EXPLAIN «після» — Index / Index Only / Bitmap Index Scan, без Seq Scan
for q in q1 q2 q3; do $PSQL -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"; done
```

Повний цикл із нуля: `docker compose down -v && docker compose up -d db --wait`,
далі кроки 1–5.

## ORM-шар (hw-13)

TypeORM над тією самою доменною моделлю, що й hw-12 (`users`, `products`,
`orders`, `order_items`) — тепер entities + relations + міграції замість
ручного `db/schema.sql`. Усі файли — у `src/`:

| Файл | Призначення |
|------|-------------|
| `src/entities/*.entity.ts` | `User`, `Product`, `Order`, `OrderItem` — типи й обмеження 1:1 з `db/schema.sql` |
| `src/migrations/` | згенерована `migration:generate`, прочитана і звірена вручну |
| `src/data-source.ts` | `DataSource` з `synchronize: false`; підключення лише з `process.env` |
| `src/seed.ts` | детермінований ідемпотентний seed (6 users, 6 products, 8 orders, 12 order_items) |
| `src/demo-nplus1.ts` | N+1 «до/після» на графі `order -> items -> product` |
| `src/report.ts` | звіт «виторг за товарами» через `createQueryBuilder().getRawMany()` |
| `src/query-count-logger.ts` | лічильник SQL-запитів (`AbstractLogger`) для `demo-nplus1.ts` |

### Підключення — окремий набір змінних від Nest-застосунку

Nest-сервер (hw-11/12) бере `DB_URL` + `DB_PASSWORD_FILE` через
`ConfigService`. CLI-скрипти цього розділу (`migrate`, `seed`,
`demo:nplus1`, `report`) — окремі одноразові процеси, що НЕ проходять
через `ConfigModule`; вони читають `DB_HOST`/`DB_PORT`/`DB_USER`/
`DB_PASSWORD`/`DB_NAME` напряму з `process.env` (`src/data-source.ts` —
жодного зашитого значення, жодного нового env-файла). У dev ці значення
інжектить обгортка `scripts/with-secrets.sh`: звичайний шлях —
`infisical run`, аварійний — `SKIP_VAULT=1` для грейдера, у якого немає
доступу до сховища (деталі й повна команда — розділ [Grading](#grading)
нижче).

### Relations і onDelete

- `orders.buyer -> users`, `onDelete: RESTRICT` — історію (чиї це були
  замовлення) видаленням `users` не ламаємо: покупця з замовленнями
  видалити не можна.
- `order_items.order -> orders`, `onDelete: CASCADE` — позиції без свого
  замовлення сенсу не мають: видалили `order` — `items` ідуть слідом.
- `order_items.product -> products`, `onDelete: RESTRICT` — товар, на
  який уже є продажі, просто так не видалити (та сама логіка, що в
  `db/schema.sql` hw-12).

`order_items` — явна join-entity `Order <-> Product` (НЕ `@ManyToMany`):
на самому зв'язку живуть дані (`quantity`, `unitPrice` — ціна на момент
покупки, а не поточна ціна товару).

`synchronize: false` у `src/data-source.ts` — схему створюють і змінюють
тільки міграції з `src/migrations/`.

`id` — `bigint` зі стратегією `identity`
(`@PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })`),
не `serial`: той самий вибір, що в `db/schema.sql` hw-12. Гроші (`price`,
`total_amount`, `unit_price`) — `numeric(12,2)`, не `float`: pg повертає
`numeric` рядком, тому в entities стоїть `numericTransformer`, що
приводить значення до `number` для зручності `seed`/`demo`/`report`.

### Команди

```bash
npm run build                 # tsc через nest build -> dist/
npm run migration:generate -- src/migrations/Name   # тільки при зміні entities
npm run migrate               # migration:run -d dist/data-source.js
npm run migrate:show          # [X]/[ ] по кожній міграції
npm run migrate:revert        # відкат останньої міграції
npm run seed                  # ідемпотентний seed
npm run demo:nplus1           # N+1 "до/після" з лічильником SQL-запитів
npm run report                # QueryBuilder-звіт "виторг за товарами"
```

Усі, що ходять у базу, — під обгорткою `bash scripts/with-secrets.sh dev …`
(див. `package.json`). Локально без сховища — `SKIP_VAULT=1` і свої
`DB_*` в оточенні (розділ [Grading](#grading)).

### Seed — ідемпотентність

```bash
npm run seed && npm run seed
docker compose exec -T db psql -U marketplace -d marketplace -Atc \
  "SELECT count(*) FROM users; SELECT count(*) FROM products; \
   SELECT count(*) FROM orders; SELECT count(*) FROM order_items;"
# -> 6 / 6 / 8 / 12 — однаково і після першого, і після другого запуску
```

`users`/`products` мають природний унікальний ключ (`email`/`sku`) ->
`upsert()` (`INSERT ... ON CONFLICT DO UPDATE`). `orders`/`order_items`
за дизайном hw-12 такого ключа не мають (це журнал подій, не довідник)
— ідемпотентність там через find-or-create по точному збігу
детермінованих полів (покупець + фіксована дата замовлення, а не
`now()`).

### N+1: числа «до/після» (граф `order -> items -> product`, 2 рівні зв'язків)

Виміряно `demo-nplus1.ts` на двох розмірах колекції (N=5 і N=40; дані —
одноразові, створені й виміряні в транзакції з `rollback` наприкінці, тож
результат відтворюваний і не залежить від того, чи вже накотили `seed`):

| Стратегія | N=5 | N=40 |
|-----------|----:|-----:|
| наївно (запит у циклі: order -> items -> product) | 11 | 81 |
| `relations: { items: { product: true } }` (LEFT JOIN) | 1 | 1 |
| `relationLoadStrategy: 'query'` | 5 | 5 |

Наївний варіант росте лінійно з N (1 запит на список + по одному на
кожен `item`, ще по одному на кожен `product`); обидва фікси лишаються
константою при зростанні N у 8 разів — це і доводить лічильник запитів,
а не «на око по коду». `relations` дає 1 запит (один `LEFT JOIN` одразу
на три таблиці); `relationLoadStrategy: 'query'` — 5 = 1 + 2×2 (2 рівні
зв'язків: `items`, `product`), без `JOIN`, батчами по `IN (...)`.

### Repository vs QueryBuilder

`Repository`/`find()` — поки результат лишається графом entity одного
домену з опціональними `relations` (CRUD, списки, деталі): типобезпечно
і читається як домен, без ручного SQL. `createQueryBuilder().getRawMany()`
береться, коли форма результату вже НЕ entity — агрегати (`SUM`/`COUNT`),
`GROUP BY`, обчислювані колонки чи `JOIN` у таблицю, якої немає серед
`relations` цієї entity (тут — `products` через `order_items` у
`report.ts`). Критерій простий: як тільки треба `.getRawMany()` замість
`.find()`, задача вже не «дістати граф об'єктів», а «порахувати звіт».

## Конкурентність (hw-14)

Транзакційна бізнес-логіка поверх entities з hw-13: що відбувається, коли
checkout викликають 50 разів одночасно на один товар. Усі файли — у `src/`:

| Файл | Призначення |
|------|-------------|
| `src/checkout.ts` | транзакційний checkout: decrement stock + списання балансу + INSERT order/order_items + INSERT задачі в черзі, усе в одній транзакції на одному `QueryRunner` |
| `src/queue-worker.ts` | `claimOne`/`runWorker` — один прохід воркера через `FOR UPDATE SKIP LOCKED` |
| `src/concurrency/lib.ts` | `createDataSource` (пул зі збільшеним `max` — 50+ паралельних чекаутів = 50+ з'єднань), `withRetry` (40001/40P01 + backoff) |
| `src/demo-race.ts` | `npm run demo:race` — 60 паралельних `checkout()` на товар зі stock=10 |
| `src/demo-workers.ts` | `npm run demo:workers` — 20 реальних задач post-processing, 4 воркери, `SKIP LOCKED` |
| `src/demo-retry.ts` | `npm run demo:retry` — read-modify-write під REPEATABLE READ, що провокує 40001 |
| `src/entities/job-queue.entity.ts` | entity таблиці `job_queue` (для `migration:generate`; сам checkout/worker ходять у неї сирим SQL) |
| `src/migrations/…-CheckoutQueue.ts` | `ALTER TABLE products ADD stock`, `ALTER TABLE users ADD balance`, `CREATE TABLE job_queue` |

### checkout() — атомарний UPDATE, не SELECT ... FOR UPDATE

Обидва списання (`products.stock`, `users.balance`) зроблені як
**атомарний `UPDATE ... SET x = x - $n WHERE ... AND x >= $n RETURNING`**, а
не `SELECT ... FOR UPDATE` + окремий `UPDATE`. Причина — перевірка
достатності і лок на рядок тут не два кроки з вікном між ними, а один
SQL-statement: Postgres сам бере лок під час `UPDATE`, сам переоцінює
`WHERE` проти найсвіжішого закомiченого значення, якщо довелось чекати на
конкурента (механізм EvalPlanQual), і сам повертає 0 рядків, якщо умова не
проходить — тобто і перевірка, і захист від гонки в одному round-trip, без
окремого `SELECT`, без окремого лока, який потрібно не забути тримати до
`UPDATE`. `SELECT ... FOR UPDATE` тут був би зайвим шаром: довелося б
тримати два лока (products, potentially users) відкритими між `SELECT` і
`UPDATE`, і при цьому отримати рівно той самий результат. Порядок локів у
`checkout()` завжди `products -> users -> orders -> order_items ->
job_queue` — однаковий для кожного виклику, тому конкурентні чекаути не
можуть чекати один на одного в протилежному порядку (передумова deadlock
40P01 — крок 5 лекції 14).

** `queryRunner.query()` у
TypeORM/pg повертає для `UPDATE ... RETURNING` **tuple `[rows, rowCount]`**,
а не просто `rows` — на відміну від `SELECT` і навіть від
`INSERT ... RETURNING`, які повертають просто масив рядків (перевірено
емпірично, докладніше — `secrets/hw-14-explained.md`). Перший варіант
checkout.ts перевіряв `result.length === 0` прямо на цьому результаті —
довжина tuple завжди 2, тож перевірка ніколи не спрацьовувала, і
`demo:race` віддавав 60 "успішних" із 60 спроб на товар зі stock=10.
`unwrapReturning()` у `checkout.ts` дістає саме `rows` з обох форм.

### demo:race — 60 паралельних checkout(), stock=10

```
спроб: 60
успішних: 10
фінальний stock: 0
рядків із відʼємним stock: 0
OK — жодного oversell.
```

Стабільно на кожному прогоні (перевірено кількаразово підряд, включно з
чистим `docker compose down -v`): успішних рівно 10 = початковий stock,
фінальний stock рівно 0, відʼємних рядків 0. Баланс покупця в цьому демо —
надлишковий (`users.balance` за замовчуванням `1000000.00`,
`src/entities/user.entity.ts`) навмисно: обмежувати успіх має саме stock
товару, а не випадковий брак коштів — інакше число успішних залежало б від
порядку виконання, а не дорівнювало б рівно stock.

### demo:workers — 20 задач, 4 воркери, SKIP LOCKED

```
ідеал (4 воркери): 500 мс · послідовно: 2000 мс
час: 539–549 мс
розподіл по воркерах: w1=5 w2=5 w3=5 w4=5
оброблено двічі: 0
OK — кожна задача оброблена рівно один раз, час менший за послідовний.
```

П'ять прогонів підряд: чотири дали ~540 мс із рівним розподілом `5/5/5/5`,
один — 881 мс із розподілом `4/4/6/6` (Node/Postgres встигли не однаково
розподілити перше "вікно" між воркерами — форма ефекту та сама, конкретні
мілісекунди й розподіл — плавають, як і в лекції 14 крок 6). `оброблено
двічі: 0` — на всіх п'яти без винятку: `SKIP LOCKED` не дає двом воркерам
взяти той самий рядок. Задачі — не синтетичні рядки в окремій таблиці, а
справжні `job_queue`-рядки, які поклав `checkout()` під час підготовки
демо (20 реальних `checkout()`-викликів перед стартом воркерів) — так демо
показує весь шлях "checkout -> черга -> воркер", а не вигадану чергу.

### demo:retry — 40001 під REPEATABLE READ

```
[A] SELECT balance -> 100
[B] SELECT balance -> 100
[A] UPDATE balance = 100 + (50) = 150
[B] спроба 1 впала: 40001 (could not serialize access due to concurrent update) → retry через ~45 мс
[B] SELECT balance -> 150
[B] UPDATE balance = 150 + (-30) = 120
фінальний balance: 120 (очікували 120)
OK — арифметика коректна.
```

Стабільно на кожному прогоні: B завжди читає *до* коміту A (старт на 50 мс
раніше за думання A), тому знімок RR у B "застарілий" на момент запису, і
Postgres відповідає `40001` рівно на UPDATE B. `withRetry` повторює
транзакцію B ЦІЛКОМ, включно з `SELECT` (не тільки `UPDATE`) — повтор
самого лише запису відтворив би той-таки lost update, тільки під іншим
приводом (постановка, п.7). Другий attempt B бачить уже 150 (закомічене
A), тому фінал арифметично коректний: 100 + 50 − 30 = 120.

**Чому retry ловить лише `40001`/`40P01`, а не всі помилки.** Обидва коди —
не баги застосунку, а штатна відповідь Postgres "транзакція коректна за
даними, які вона бачила, але повторити її треба цілком": `40001`
(`serialization_failure`) — конфлікт видимості під RR/SERIALIZABLE,
`40P01` (`deadlock_detected`) — обрана жертва в циклі очікування локів. В
обох випадках повторний запуск ТІЄЇ САМОЇ транзакції з чистого знімка
майже завжди проходить. Будь-яка інша помилка (`23514` порушення CHECK,
`23503` порушення FK, синтаксична помилка запиту) означає, що транзакція
помилкова НЕЗАЛЕЖНО від конкурентів — повторювати її сліпо в циклі означало
б ховати реальний баг за нескінченним retry-логом замість того, щоб дати
йому впасти на виклик.

Чому саме `checkout()` не потребує `withRetry`: `checkout()` не робить
read-modify-write в застосунку (SELECT -> думаємо -> UPDATE) — атомарний
`UPDATE ... RETURNING` без проміжного читання просто не залишає Postgres
приводу видати `40001` під дефолтним READ COMMITTED (немає знімка, який
міг би "застаріти"). `demo-retry.ts` — навмисно ІНШИЙ, реалістичний
read-modify-write сценарій (баланс без атомарного UPDATE, під REPEATABLE
READ), щоб чесно показати, де retry-патерн потрібен насправді.

## Пулер зʼєднань і бекапи (hw-15)

```
pgbouncer/pgbouncer.ini   — конфіг PgBouncer: pool_mode=transaction, default_pool_size=10,
                            max_client_conn=200, адмін-консоль (admin_users)
pgbouncer/userlist.txt    — лише службова роль pgbouncer_auth (dev-фейк-пароль)
scripts/init.sql          — + роль pgbouncer_auth і функція pgbouncer.get_auth (auth_query)
scripts/backup.sh         — pg_dump -Fc -> backups/<db>-<дата>_<час>.dump
scripts/restore-drill.sh  — останній дамп -> чистий контейнер -> звірка -> MATCH / MISMATCH
scripts/lib-conn.sh       — спільне: DATABASE_URL (або DB_*) -> роль і імʼя бази
backup.cron               — щоночі о 03:00
RESTORE-DRILL.md          — протокол drill-у: дата, розмір, час, RTO, RPO
```

### PgBouncer

`docker compose up -d --wait` піднімає `db`, `pgbouncer` (порт **6432**, опублікований
на хост) і `api`. Застосунок ходить у базу через PgBouncer: у compose
`DB_URL=postgres://marketplace@pgbouncer:6432/marketplace`, а рядок-контракт у
`.env.example` вказує на `localhost:6432`. Прямий порт Postgres (5432) лишився
опублікованим лише для `psql -f /db/schema.sql` (hw-12) і `pg_dump`. Нового секрета
немає: змінилося лише **значення** `DB_URL` (сховище hw-11, оточення dev і prod); пароль
ролі `marketplace` і далі береться з файла `DB_PASSWORD_FILE`.

```bash
# запит через пулер
PGPASSWORD=dev_secret_pw psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c "SELECT 1"
# адмін-консоль: база marketplace, pool_mode = transaction
PGPASSWORD=pgbouncer_auth_dev_pw psql -h 127.0.0.1 -p 6432 -U pgbouncer_auth -d pgbouncer -c "SHOW POOLS"
```

**Автентифікація через `auth_query`, а не `userlist.txt` з паролем ролі.** `rotate.sh`
(hw-11) міняє пароль `marketplace` у БД; статичний файл із паролем на боці PgBouncer
одразу застарів би, і ротація «без рестарту» зламалась би саме тут. Тому PgBouncer
логіниться службовою роллю `pgbouncer_auth` (її пароль не ротується) і щоразу питає
SCRAM-хеш клієнта функцією `pgbouncer.get_auth` — ротація проходить без правок конфігу
й без рестарту PgBouncer (перевірено: після `rotate.sh` новий пароль пускає, старий — ні).

**Чому transaction mode і що він ламає.** У transaction mode серверне зʼєднання
видається клієнту лише на час транзакції, тож 200 клієнтів ділять між собою 10
backend-ів Postgres, а не тримають по процесу кожен — саме це дає масштаб, коли
подів багато, а `max_connections` в бази обмежений. Ціна: усе, що живе довше за
транзакцію, більше не гарантоване. Ламаються (1) `SET` / `SET search_path` поза
транзакцією — наступний запит може потрапити на інший backend, де налаштування нема
(`SET LOCAL` усередині транзакції безпечний); (2) `LISTEN/NOTIFY` — підписка живе на
конкретному backend-і, а зʼєднання вже повернулось у пул; (3) advisory locks рівня
сесії (`pg_advisory_lock`) — лок належить backend-у і «губиться» разом із поверненням
у пул (лише `pg_advisory_xact_lock`); (4) іменовані prepared statements — вони
привʼязані до backend-а (у нас `max_prepared_statements = 0`); (5) `WITH HOLD`-курсори
й тимчасові таблиці на сесію. Транзакційні патерни hw-14 (checkout, `SKIP LOCKED`,
retry на 40001) працюють через PgBouncer без змін — усе відбувається всередині однієї
транзакції, перевірено `demo:race` / `demo:workers` / `demo:retry` на порту 6432.

### Бекап

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
# backup: 29 обʼєктів у TOC, 13M
# ./backups/marketplace-2026-09-20_214605.dump
```

`pg_dump -Fc` виконується в контейнері `db` через unix-сокет (`docker compose exec`),
**у обхід PgBouncer**: бекап — довга транзакція зі знімком, пулер тут нічого не дає.
Файл пишеться в `backups/` на хості (поза контейнером, у `.gitignore`/`.dockerignore`)
спершу як `.partial` і перейменовується лише після успіху та перевірки TOC
(`pg_restore --list`); старші за `BACKUP_KEEP_DAYS` (14) дампи видаляються.
`backup.cron` запускає скрипт щоночі о 03:00 (`crontab backup.cron`).

### Restore-drill

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh   # MATCH або exit 1
```

Скрипт бере останній дамп, знімає з живої бази кількість рядків усіх таблиць і
`count/sum(total_amount)` по `orders`, піднімає **чистий** контейнер
(`docker run` того самого образу; анонімний том — новий і порожній), відновлює дамп і
порівнює ті самі значення. Контейнер і том скрипт сам прибирає (`trap EXIT`), тож
повторний запуск теж стартує з порожнього. Порожня база не є помилкою (свіжий клон),
але скрипт попереджає, що звірка нічого не доводить — спершу
`npm run build && npm run migrate && npm run seed`. Виміряні RTO/RPO — у
[RESTORE-DRILL.md](RESTORE-DRILL.md).

## Тестування (hw-16)

Драбинка довіри над hw-09/13/14: інтеграційні тести data layer, E2E головної
фічі через supertest і контракт (Pact), що робить спеку hw-09 виконуваною.
Усі файли — у `test/`:

| Файл/каталог | Призначення |
|---|---|
| `test/testkit/pg-container.ts` | `startPg()` — testcontainers Postgres + `dataSourceOptions` з `src/data-source.ts` (ті самі `dist/migrations/*.js`, що й dev/prod) |
| `test/testkit/builders.ts` | `aUser()`, `aProduct()`, `anOrder()` — валідні унікальні дефолти |
| `test/integration/*.repo.test.ts` | репозиторії `Product`/`Order` (TypeORM `Repository<T>`) проти testcontainers |
| `test/e2e/orders.e2e-spec.ts` | supertest: повний `AppModule`, `POST /orders -> GET /orders/:id` + 2 негативні кейси |
| `test/contract/consumer.pact.test.ts` | Pact consumer (`marketplace-web`) → `pacts/*.json` |
| `test/contract/provider.verify.test.ts` | Pact provider verification (локальний файл або брокер — залежно від `PACT_BROKER_URL`) |
| `jest.config.js` + `test/jest-*.config.js` | спільна база (`reporters: ['default']`) + testMatch на кожен шар |
| `tsconfig.test.json` | окремий від кореневого `tsconfig.json` — тести НЕ впливають на `npx tsc --noEmit` |
| `.github/workflows/contract.yml` | CI job `contract`: publish → verify (`publishVerificationResult: true`) → `can-i-deploy` |

### Команди

```bash
npm run test:integration   # testcontainers: 2 репозиторії × 3+ тестів (unique 23505, FK 23503, JOIN, GROUP BY)
npm run test:e2e           # supertest: повний Nest-застосунок, happy path + 404 + 400
npm run test:contract      # Pact consumer -> pacts/marketplace-web-marketplace-api.json
npm run verify:provider    # Pact provider verification (локальний файл; з PACT_BROKER_URL — з брокера)
```

Усі чотири самі роблять `npm run build` (потрібні `dist/migrations/*.js`) — окремо
збирати проєкт перед ними не треба.

### Ізоляція тестів — свідомий вибір

**Контейнер на файл + TRUNCATE між тестами всередині файла.** `beforeAll` у
кожному тестовому файлі піднімає СВІЙ postgres:16-alpine і накочує міграції
(`dist/migrations/*.js` — ті самі, що й dev/prod), `beforeEach` робить
`TRUNCATE ... RESTART IDENTITY CASCADE` (`PgHandle.truncateAll()`). Чому не
чиста транзакція-ROLLBACK (найдешевша зі стратегій лекції): репозиторій тут
— `DataSource.getRepository()` з власним пулом з'єднань TypeORM, а не один
`Client` з відкритим `BEGIN`, який можна підсунути в конструктор (як
`Queryable` у лекції) — переробляти access-шар заради тестової стратегії
не хотілося. Чому не один спільний контейнер на весь прогін: два файли
(`products.repo`, `orders.repo`) виконуються паралельно небезпечно лише
теоретично (`maxWorkers: 1` в конфізі), але контейнер-на-файл лишає їх
незалежними навіть якщо хтось підніме `maxWorkers` вище. Повторний
`npm run test:integration && npm run test:integration` зелений обидва рази
без ручної чистки — кожен запуск піднімає нові контейнери з нуля.

### Provider verification: локальний файл vs брокер

Один скрипт `verify:provider`, дві гілки в `test/contract/provider.verify.test.ts`
за наявністю `PACT_BROKER_URL` (`process.env`, не константа в коді):

- без змінної — `pactUrls: [pacts/marketplace-web-marketplace-api.json]` (базовий acceptance-критерій, брокер не потрібен);
- зі змінною — `pactBrokerUrl` + `publishVerificationResult: true` (той самий виклик, яким користуються CI-джоба `contract` і локальний гейт нижче).

`stateHandlers` тут НЕ сідять БД: ресурси цього API (`products`/`orders`) —
in-memory (Postgres обслуговує лише
`/health/db` і ротацію пароля), товар `p1` з інтеракції контракту завжди
присутній у каталозі — стан-хендлер лишається no-op з поясненням у коді.

### Підняти брокер локально

```bash
npm run broker:up      # docker compose up -d --wait pact-broker (+ pact-broker-db, порт 9292)
npm run broker:down    # прибрати обидва контейнери
```

### Локальний еквівалент CI-гейту (той самий, що в `.github/workflows/contract.yml`)

Порядок кроків обовʼязковий: спершу публікація й **успішна** верифікація, і лише ПІСЛЯ неї —
`can-i-deploy` між кроками "verify" і "tag prod" все одно чесно лишається
`unknown` (доказ, що причина саме відсутній тег `prod`, а не відсутня
верифікація); тег `prod` переводить ту саму відповідь у `true` (реальний
прогін нижче, 23.09.2026):

```bash
npm run test:contract                    # генерує pacts/marketplace-web-marketplace-api.json
npm run broker:up                        # брокер на 9292

curl -s -X PUT 'http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-web/version/1.0.0' \
  -H 'Content-Type: application/json' -d @pacts/marketplace-web-marketplace-api.json -o /dev/null -w '%{http_code}\n'
# -> 201

PACT_BROKER_URL=http://127.0.0.1:9292 PROVIDER_VERSION=1.0.0 npm run verify:provider   # exit 0, публікує результат

curl -s 'http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=1.0.0&to=prod'
# -> {"deployable":null,"reason":"There is no verified pact between version 1.0.0 of marketplace-web
#     and the latest version of marketplace-api with tag prod (no such version exists)",
#     "success":0,"failed":0,"unknown":1}
# ВЕРИФІКАЦІЯ ВЖЕ ПРОЙШЛА (крок вище — exit 0), але деплой все ще "unknown":
# бракує САМЕ тега prod, а не результату верифікації.

curl -s -X PUT 'http://127.0.0.1:9292/pacticipants/marketplace-api/versions/1.0.0/tags/prod' \
  -H 'Content-Type: application/json' -o /dev/null -w '%{http_code}\n'
# -> 201

curl -s 'http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=1.0.0&to=prod'
# -> {"deployable":true,"reason":"All required verification results are published and successful",
#     "success":1,"failed":0,"unknown":0}

npm run broker:down
```

Основний (не аварійний) шлях провайдерської верифікації — через сховище
секретів hw-11, той самий патерн, що й `migrate`/`seed`:

```bash
bash scripts/with-secrets.sh dev npm run verify:provider
```

`with-secrets.sh` інжектить `PACT_BROKER_URL`/`PACT_BROKER_TOKEN` з
Infisical (оточення `dev`); під `SKIP_VAULT=1` (грейдер) обгортка просто
виконує ту саму команду, а значення бере з уже виставленого оточення —
локальний дефолт `http://127.0.0.1:9292` у коді не є секретом (це адреса
власного compose), тому підходить і без сховища.

### CI: job `contract` (`.github/workflows/contract.yml`)

Піднімає лише `pact-broker` (+ його `pact-broker-db`) із того самого
`docker-compose.yml` — `db`/`pgbouncer`/`api` тут не потрібні: contract-тести
піднімають свій Postgres через testcontainers. Кроки: `npm run test:contract`
→ publish curl'ом → `npm run verify:provider` (`publishVerificationResult: true`,
`providerVersion: github.sha`) → `can-i-deploy`, що валить джобу, якщо
`deployable !== true`. `PACT_BROKER_TOKEN` — з GitHub secrets (для власного
compose-брокера без автентифікації не обов'язковий, але код і CI вміють його
передати). Як і в лекції, до першого тега `prod` на версії провайдера ця
джоба чесно провалиться на `can-i-deploy` — це не баг конфігурації, а сенс
гейту (див. вище).

## Realtime-шар (hw-18)

Покупець дізнавався про зміну статусу замовлення лише при перезавантаженні
сторінки. hw-18 додає realtime-нотифікацію «статус замовлення змінився»
двома транспортами над однією шиною подій — щоб на власному коді відчути
trade-offs WebSocket проти SSE.

**Спільна шина** — `src/orders/order-events.service.ts`: RxJS `Subject`
(гарячий, мультикастить усім підписникам одразу) + буфер останніх 100 подій
**на кожне замовлення окремо** (для догравання пропущеного SSE-клієнту).
Бізнес-логіка зміни статусу (`OrdersService.updateStatus`) — єдине місце,
звідки йде `emitStatusChange`; і WS-gateway, і SSE-контролер лише
підписуються на `events$`, самі нічого не міняють.

**WebSocket** — `src/orders/orders.gateway.ts` (`@WebSocketGateway()`,
socket.io). Ідентичність покупця (`buyerId`) курсовий бере з
handshake-`auth` при підключенні (`io(url, { auth: { buyerId } })`) —
справжньої авторизації у проєкті ще немає (`openapi.yaml`: `security: []`,
майбутнє ДЗ), тому це свідомо проста заглушка, а не крипто-перевірка.
Клієнт шле `join` з id замовлення; gateway кладе сокет у кімнату
`orders:<id>` лише якщо замовлення існує і `buyerId` збігається з його
`buyer_id` — анонімному (без `buyerId`) чи чужому клієнту відповідає
`{ok:false, reason:'not-found'|'forbidden'}` і в кімнату не пускає. Коли
`updateStatus` спрацьовує, gateway емітить `order.status` лише в кімнату
цього замовлення (`server.to(...)`), а не всім підключеним.

**SSE** — `GET /orders/{id}/events` у `src/orders/orders.controller.ts`,
`content-type: text/event-stream`. Кожна подія — `id:`/`event:`/`data:`, той
самий формат, що в лекційному кроці 3. Реконект із заголовком
`Last-Event-ID: N` доганяє з буфера події з `id > N` цього замовлення, потім
переходить у живий потік. Маршрут навмисно НЕ в `openapi/openapi.yaml` — як
`/health`/`/health/db`, він проходить повз express-openapi-validator через
`ignoreUndocumented: true` (нескінченний стрім не звірити зі схемою JSON).

### Headless-демо ізоляції кімнат

```bash
node scripts/realtime-demo.mjs               # основний: різні кімнати — B не чує подію A
node scripts/realtime-demo.mjs --same-room   # контрольний: обидва в кімнаті A — B МУСИТЬ почути
```

Скрипт створює два замовлення (кожне зі своїм `buyer_id`), підключає два
socket.io-клієнти, чекає ack `joined` від обох, і лише ПОТІМ міняє статус
замовлення A через `PATCH /orders/{id}/status`. У контрольному режимі другий
клієнт заходить у кімнату замовлення A під тим самим `buyerId`, що й перший
(інакше перевірка власності відхилила б його join, і вимірювався б відмова в
доступі, а не ізоляція кімнат) — міняється лише кімната, не логіка перевірки.

### Trade-offs: WebSocket vs SSE

| Критерій | WebSocket | SSE |
|---|---|---|
| Напрям каналу | двосторонній (клієнт теж шле) | лише сервер → клієнт |
| Реконект/відновлення | руками (або з коробки в socket.io: авто-реконект + `connectionStateRecovery`) | вбудовано в `EventSource` — сам реконектиться і сам шле `Last-Event-ID` |
| Вимоги до інфраструктури | окремий протокол після `Upgrade`; проксі/CDN/деякі balancer'и іноді ріжуть `Upgrade` або обривають ідле-з'єднання | звичайний HTTP-стрім — працює скрізь, де працює HTTP, включно з HTTP/2 |
| Ціна на подію | фрейм (від ~2 байтів заголовка) після рукостискання | кілька байтів (`id:`/`event:`/`data:`) у вже відкритий потік |
| Масштабування на N інстансів | кімнати живуть у пам'яті процесу — без Redis-адаптера сокет на іншому інстансі нотифікацію не побачить | той самий буфер-у-пам'яті обмежений одним процесом; N інстансів так само потребують спільного стану (Redis pub/sub, черга) |

Для нотифікацій про статус замовлення я лишив би **SSE**: канал і так
однонаправлений (сервер → клієнт), а безкоштовний авто-реконект з
`Last-Event-ID` у браузерному `EventSource` знімає рівно ту роботу
(«що я пропустив, поки був відключений»), яку тут довелося писати руками для
WebSocket. WS має сенс лише якщо з'явиться зворотний канал від покупця
(чат підтримки, редагування замовлення в реальному часі).

Для одного інстанса (як зараз) Redis-адаптер не потрібен — але при двох
інстансах кімнати `orders:<id>` живуть у пам'яті КОЖНОГО процеса окремо, тож
`server.to(room).emit(...)` на інстансі А не долетить до сокета, підключеного
до інстансу Б; лікується `@socket.io/redis-adapter`.

## Async-події через RabbitMQ

Між `checkout()` (hw-14) і тими, хто реагує на замовлення, стоїть брокер, який
зберігає повідомлення, доки не зʼявиться одержувач (WebSocket із hw-18 доставляв
лише тому, хто підключений зараз). Код — `src/messaging/`, брокер —
`rabbitmq:4.3.4-management-alpine` у `docker-compose.yml` (AMQP — `5672`,
вебморда — `15672`, dev-креденшели `app:app`).

| Файл | Призначення |
|------|-------------|
| `src/messaging/topology.ts` | `assertTopology` — exchange, черга, binding, DLX + DLQ, alternate exchange; викликає споживач/бутстрап, **не** продюсер |
| `src/messaging/events.ts` | контракт `order.placed` (`eventId`, `type`, `occurredAt`, `data`) + стабільний `eventId` |
| `src/messaging/publisher.ts` | публікація через `createConfirmChannel` + `waitForConfirms`, `mandatory: true` |
| `src/messaging/consumer.ts` | `noAck: false`, ack після ефекту, `prefetch`, ідемпотентний INSERT |
| `src/messaging/consumer-process.ts` | той самий споживач окремим процесом (для `kill -9` у `demo:duplicate`) |
| `src/checkout.ts` | (hw-19) публікував `order.placed` **після COMMIT** — dual write; з hw-22 пише подію в `outbox` тією ж транзакцією, див. [Outbox та ідемпотентність](#outbox-та-ідемпотентність) |
| `src/demo-publish.ts` / `demo-dlq.ts` / `demo-duplicate.ts` | три демо з контрактом `ключ=значення` |
| `src/migrations/…-OrderReceipts.ts` | таблиця ефекту `order_receipts (event_id PRIMARY KEY, …)` |

### Топологія

```
checkout() ──order.placed──▶ [shop.events : topic] ──binding order.placed──▶ (shop.order-placed : quorum)
                                  │ alternate-exchange                          │ x-dead-letter-exchange
                                  ▼                                             ▼
                        [shop.unroutable : fanout] ▶ (shop.unroutable)   [shop.dlx] ▶ (shop.order-placed.dlq)
```

- Черги — `quorum` (працює `x-delivery-limit`; для `order.placed` ліміт = 5).
- DLX на робочій черзі — **аргументом** при оголошенні (`x-dead-letter-exchange`,
  `x-dead-letter-routing-key`). Аргументи черги незмінні: змінити їх на існуючій
  черзі = `406 PRECONDITION_FAILED`, тож зміна означає `delete` + створення
  (політика цього б не потребувала).
- Routing key без binding не зникає мовчки: **alternate exchange** `shop.unroutable`
  ловить такі повідомлення (брокер при цьому віддає продюсеру позитивний confirm —
  без AE ми б цього не побачили). `demo:publish` показує це рядком `unroutable=1`.
- `dead-letter-strategy` лишено дефолтною (`at-most-once`): `at-least-once`
  вимагає `overflow: reject-publish`, інакше брокер мовчки відкотиться на
  `at-most-once` і скаже про це лише в лозі. Для ДЗ дефолт достатній.

### prefetch = 10

`prefetch × час обробки < consumer_timeout`: обробка однієї події — один INSERT у
Postgres (≈ кілька мс, весь `demo:publish` на 5 подій займає ≈ 0.7 с), тож
10 × ~10 мс ≈ 0.1 с ≪ 30 хв (стоковий `consumer_timeout`, у compose його не
змінено); `prefetch=1` для 2-мілісекундних задач дав би простій конвеєра на
кожному round-trip ack-а, а дефолт брокера (0 = без ліміту) віддав би всю чергу
першому ж споживачу.

### Числа трьох прогонів (RabbitMQ 4.3.4, Postgres 16, 11.10.2026)

| Демо | Вивід | Час |
|------|-------|-----|
| `demo:publish` | `published=5 delivered=5 effect=5 acked=5 work=0 dlq=0 unroutable=1 prefetch=10` | ≈ 0.7 с |
| `demo:dlq` | `rejected=1 work=0 dlq=1 dlq-reason=rejected effect=0` | ≈ 0.7 с |
| `demo:duplicate` | `deliveries=2 effect=1 skipped=1 redelivered=1 work=0 dlq=0` | ≈ 0.7 с |

Кожне демо саме приводить стан до чистого (міграції, топологія, `purge` черг,
очищення `order_receipts`), друкує підсумок і завершується з кодом ≠ 0, якщо
інваріант порушено.

- **`demo:dlq`** — отруєне повідомлення (не JSON) → `reject(requeue=false)` →
  `shop.dlx` → DLQ. Причину читаємо з `x-first-death-reason` (і `x-death`):
  `rejected`. Інші причини з чотирьох — `expired`, `maxlen`, `delivery_limit`;
  п'ятої немає (протухання самої черги — не dead-letter).
- **`demo:duplicate`** — повторна доставка викликана справжнім `SIGKILL`
  дочірнього процесу-споживача **після** ефекту, але **до** ack (пауза
  `CONSUMER_GAP_MS=3000`). Не `channel.close()`: воно коректне, а падіння в проді
  — це зникнення процесу й обрив сокета. `deliveries=2` — дубль справді був;
  `effect=1` — ефект застосовано один раз.

### Чому це at-least-once, а не exactly-once

Exactly-once **доставки** не існує: ack — односторонній сигнал по ненадійному
каналу і означає «я більше не вимагаю повтору», а не «дійшло». Підтвердив рано
(`autoAck`) — втрата; підтвердив пізно (ефект є, ack не доїхав) — повторна
доставка; третього немає. Тому RabbitMQ тут дає **at-least-once доставку**
(ручний ack після ефекту, confirm-публікація, DLQ для отрути), а **одиничний
результат** забезпечує споживач: ефект записано через природний ключ
`INSERT INTO order_receipts … ON CONFLICT (event_id) DO NOTHING`, де `event_id` —
стабільний `eventId` події (детермінований від id замовлення, а не випадковий
UUID на кожну спробу). Операція «додати чек» ідемпотентна за побудовою; якби
ефектом було `qty = qty - 1`, довелося б вести ключ ідемпотентності.
At-least-once доставка + ідемпотентний ефект = exactly-once **результат**.
Сховище ключів — Postgres, а не `Set` у памʼяті: воно переживає рестарт
споживача і спільне для реплік.

Чесні межі (закриваються в ДЗ #22): (1) `checkout()` публікує **після** COMMIT —
падіння між COMMIT і confirm лишає замовлення без події (спільного COMMIT бази й
брокера не існує → transactional outbox); (2) якби позначка «оброблено» і ефект
були окремими записами, між ними лишалась би щілина — тут вона відсутня лише тому,
що ключ і ефект — це один і той самий INSERT; для зовнішнього ефекту її закриває
спільна транзакція (`processed_messages`, ДЗ #22).

## Outbox та ідемпотентність

hw-19 публікував `order.placed` **після** COMMIT — це dual write: спільного COMMIT
між Postgres і брокером не існує, і між двома записами вміщається падіння процесу
(замовлення є, події немає). З hw-22 `checkout()` пише подію в таблицю `outbox`
**тією самою транзакцією**, що й замовлення, а в брокер її виносить окремий
relay-процес. Ціна — доставка стає **at-least-once**; exactly-once отримуємо не від
брокера, а від ідемпотентного ефекту на консюмері.

```
POST /orders ─ Idempotency-Key ─► ┌──── ОДИН COMMIT ────────────────────────────┐
  (рівень 3: idempotency_keys)    │ orders + order_items + job_queue + outbox    │
                                  └──────────────┬───────────────────────────────┘
                       relay: SELECT … published_at IS NULL FOR UPDATE SKIP LOCKED
                              → publish (confirm) → UPDATE published_at
                                                 │  at-least-once, дублі можливі
                                       RabbitMQ (окремий процес)
                                                 │
        consumer: ОДНА транзакція { INSERT processed_messages … ON CONFLICT DO NOTHING   (рівень 2: inbox)
                                    INSERT order_receipts   … ON CONFLICT DO NOTHING }   (рівень 1: природний ключ order_id)
```

| Файл | Призначення |
|------|-------------|
| `src/migrations/…-Outbox.ts` | `outbox` (+ частковий індекс `WHERE published_at IS NULL`), `processed_messages`, `idempotency_keys`, `UNIQUE (order_id)` на `order_receipts` |
| `src/checkout.ts` | рядок ключа → склад/баланс → замовлення → `INSERT outbox` → COMMIT; публікації в транзакції немає |
| `src/messaging/events.ts` | `toOrderPlacedEvent(order)` — явний контракт події, а не ORM-сутність через spread |
| `src/outbox/relay.ts` | `relayOnce` (SKIP LOCKED → publish → UPDATE), `startRelay` (polling-цикл) |
| `src/messaging/consumer.ts` | `applyOrderPlaced`: inbox + природний ключ в одній транзакції |
| `src/outbox/orders-api.ts` | HTTP-край `POST /orders` з `Idempotency-Key` (`node:http`) |
| `src/demo-outbox.ts` / `demo-crash-write.ts` / `demo-crash-relay.ts` | три демо (+ `src/outbox/relay-process.ts` — relay окремим процесом для `kill -9`) |

**Поля `outbox`** — ролі як у Debezium Outbox Event Router: `aggregate_type`
(маршрут), `aggregate_id` (ключ партиціонування/порядку), `type`, `payload jsonb`,
`created_at`, `published_at` (NULL = ще не винесено), `attempts`. ⚠️ Канонічні імена в
Debezium **без підкреслень** (`aggregatetype`, `aggregateid`), і саме `aggregatetype`
стоїть у `route.by.field` за замовчуванням; ми лишили snake_case, тож при переїзді на
CDC доведеться або перейменувати колонки, або явно виставити `route.by.field` і
`table.field.event.key`.

**Три рівні ідемпотентності.**
1. *Природний ключ (ефект):* `order_receipts` має `UNIQUE (order_id)`; ефект висловлено
   як «квитанція замовлення існує» (`INSERT … ON CONFLICT DO NOTHING`), а не
   `UPDATE … qty = qty - 1`, який на другій доставці зняв би вдвічі.
2. *Inbox:* `processed_messages (message_id, consumer)`; позначка й ефект — **один
   COMMIT** (`ds.transaction`). Позначка в Redis + ефект у Postgres — це знову dual write.
3. *API-край:* `Idempotency-Key` → таблиця `idempotency_keys`. Ключ ідентифікує
   **намір**, а не тіло: хеш тіла схлопнув би два легітимні однакові замовлення в одне.
   Ключ «займається» першим рядком тієї самої транзакції, що й замовлення + outbox:
   паралельний дубль блокується на унікальному індексі до COMMIT/ROLLBACK першого,
   відкат (`out_of_stock`) звільняє ключ. Повтор → `200` + `Idempotent-Replayed: true`,
   перший запит → `201`.

**Якого `kill` я обрав.** `demo:crash-relay` — справжній `kill -9` (SIGKILL) дочірнього
процесу `relay-process.js` рівно після підтвердження брокера й до `UPDATE published_at`.
`demo:crash-write` — змодельований збій: виняток у транзакції checkout після
`INSERT INTO outbox` (hook `afterOutboxInsert`, єдиний у коді test seam).

### Власні числа трьох прогонів (13.10.2026, Node v22.14.0, Postgres 16, RabbitMQ 4.3.4)

| Демо | Вивід | Що доводить |
|------|-------|-------------|
| `demo:outbox` | `requests=2 orders=1 outbox=1 published=1 deliveries=1 effect=1 processed=1` (HTTP `201` + `200`) | 2 запити з одним ключем → 1 замовлення, 1 подія, 1 ефект |
| `demo:crash-write` | `write-failed=1 orders=0 outbox=0 published=0 deliveries=0 effect=0` (+ `stock_restored=1`) | рядок outbox зник разом із замовленням: один COMMIT, а не два |
| `demo:crash-relay` ⭐ | `published=1 deliveries=2 applied=1 effect=1 processed=1` (+ `skipped=1`, `published_after_kill=0`) | подія доставлена двічі, ефект один — at-least-once + ідемпотентність |

Кожне демо саме приводить стан до чистого (міграції, топологія, `purge` черг,
`TRUNCATE outbox, processed_messages, idempotency_keys`, `DELETE FROM order_receipts`,
замовлення власного демо-покупця) і завершується з кодом ≠ 0, якщо інваріант порушено —
зокрема якщо збій не дійшов до потрібної точки (демо «нічого не довело»).

**Чому не можна просто поміняти місцями `publish` і `UPDATE published_at`.** Якщо
спершу позначити рядок винесеним, а потім публікувати, то падіння (або відмова брокера)
між двома кроками дає «позначили, але не віддали»: `published_at` вже стоїть, relay цей
рядок більше не візьме, подія **втрачена назавжди** — і не лікується нічим. У порядку
`publish → UPDATE` те саме падіння дає «віддали, але не позначили»: relay візьме рядок
вдруге й опублікує дубль. Вибір не між «добре» і «погано», а між **дублем** і
**втратою**; дубль лікується дедуплікацією на консюмері (`processed_messages` + природний
ключ), втрата — ніяк. До того ж помилка `publish` не означає, що повідомлення не
доставлено (могла загубитись відповідь брокера), тож «зловили помилку → відкотили → чисто»
не працює: саме тому дедуп на консюмері обовʼязковий, як би акуратно не писали relay.

**Порядок.** `ORDER BY created_at, id` у relay задає лише порядок *вибірки*: `SKIP LOCKED`
розкидає рядки між воркерами, тож порядок доставки не гарантується. Він існує лише в межах
ключа партиціонування (`aggregate_id`); консюмер на глобальний порядок не покладається.
Курсор по `id` не використовуємо: `bigserial` видає номер на `nextval`, а видимим рядок
стає на COMMIT — «усе, що більше за останній оброблений id» пропускає рядки довгих
транзакцій. Тому в relay `published_at IS NULL`.

**Чистка outbox.** Таблиця росте, а частковий індекс, від якого залежить relay, росте
разом з нею лише поки є невинесені рядки. Винесені рядки видаляємо періодичним
`DELETE FROM outbox WHERE published_at < now() - interval '7 days'` (cron/pg_cron, партіями
по кілька тисяч, щоб не тримати довгі локи); на великих обсягах — партиціювання за
`created_at` і `DROP PARTITION`. Те саме для `processed_messages`, але TTL inbox має
перевищувати максимальний строк, за який брокер може повторно доставити повідомлення.

**Що поза межами.** HTTP-сервер Nest (`POST /orders`, шлях A) досі in-memory і з
outbox не повʼязаний: `orders-api.ts` — окремий HTTP-край поверх `checkout()` (шлях B),
як і решта data-шару. Мігрувати relay на CDC (Debezium + Outbox Event Router) можна без
зміни консюмерів — таблиця вже в канонічній формі.

## Redis: кеш, сесії, ліміти, черга

Redis не робить систему правильною — він робить її **швидкою**. Усе, що тут
захищено Redis-ом, або є оптимізацією (кеш, лок проти stampede), або мусить мати
атомарність, яку дає Lua (ліміт). Бізнес-інваріанти (stock, баланс, ідемпотентність
замовлення) лишаються в Postgres, як у hw-14/22.

| Файл | Призначення |
|------|-------------|
| `src/redis/cache.ts` | `CacheAside`: TTL=300+random(0..60) с, single-flight лок, compare-and-delete, кеш ніколи не валить запит |
| `src/redis/product-card.ts` | «важке» читання — картка товару: `JOIN reviews` + `AVG(rating)` + залишок |
| `src/redis/session.ts` | `SessionStore` (`GETEX` = rolling TTL) + connect-style middleware |
| `src/redis/rate-limit.ts` | `RateLimiter`: ковзне вікно одним Lua-скриптом, 429 + `Retry-After` |
| `src/redis/queue.ts` | BullMQ: `attempts`, exponential backoff + jitter, `jobId`, `upsertJobScheduler` |
| `src/migrations/…-Reviews.ts` | таблиця `reviews` — джерело рейтингу |
| `src/demo-{cache,session,ratelimit,queue}.ts` | самоочисні демо, друкують `ключ=число` |

### Чому Redis-інстансів два (і де що живе)

`docker-compose.yml`: **`redis-cache`** (`:6379`, `--maxmemory 32mb --maxmemory-policy
allkeys-lru`, без персистентності) і **`redis-queue`** (`:6380`, `--maxmemory-policy
noeviction --appendonly yes --appendfsync everysec`). Інстансів два, бо
`maxmemory-policy` — одна на весь процес Redis і `SELECT 1` її не розводить: кеш
**хоче**, щоб Redis викидав ключі, а BullMQ каже, що черга «cannot work properly if
Redis evicts keys arbitrarily». Підключити BullMQ до кеш-інстансу — значить отримати
`IMPORTANT! Eviction policy is allkeys-lru` у логу й задачі, що зникають.

- **Сесії → `redis-queue`** (обрано свідомо). На кеш-інстансі `allkeys-lru` рано чи пізно
  викинув би живу сесію — розлогінення, яке неможливо відтворити. Третій контейнер
  чистіший, але для цього обсягу зайвий; ціна рішення — сесії ділять памʼять із чергою
  (при заповненні `noeviction` дасть OOM на запис, а не тихо втратить дані).
- **Лічильники ліміту → `redis-cache`**: втрата лічильника = клієнту на мить дозволили
  трохи більше, не втрата даних.
- Змінні: `REDIS_URL` (кеш) і `REDIS_QUEUE_URL` (черга) — зі сховища ДЗ #11 через
  `scripts/with-secrets.sh`, у `env.schema.ts`/`.env.example` їх немає (як `DB_*`, `BROKER_URL`).

### 1–2. Cache-aside + джитер + single-flight

Читання: `GET card:<id>` → влучання повертається; промах → (лок) → `SELECT` → `SET … EX`.
TTL ставиться **завжди** = `300 + random(0..60)`, інакше ключі, прогріті одним циклом,
протухають в одну секунду. Явна інвалідація (`CacheAside.invalidate`, її викликає
обробник `recalc-rating`) — **додатково** до TTL, не замість.

Single-flight: `SET lock:card:<id> <token> NX PX 5000`; той, хто взяв, робить **один**
`SELECT` (після взяття лока кеш перечитується ще раз — інакше «запізнілий» отримав би
лок, коли лідер уже заповнив кеш і зняв свій), решта кожні 20 мс перечитує кеш. Знімається
лок Lua compare-and-delete (`if get == token then del`), не голим `DEL`. Redis-помилки
(недоступність, OOM) кеш ковтає й іде в базу.

`db-calls` рахується **на рівні драйвера**: `DataSource` демо має `QueryCountLogger`
(`logging: ['query']`), тобто рахуються SQL-запити, що реально пішли в Postgres, а не
виклики нашої функції.

Власні числа (Node v22.14.0, Redis 8, Postgres 16, 16.10.2026; 4 поспіль прогони):

| Що | Результат |
|----|-----------|
| прогріто карток / різних TTL | 60 / 35–41 (без джитера було б 1) |
| ключ витіснено по-справжньому (заливка холодних даних під `allkeys-lru`, не `DEL`) | так, кого забрав LRU — вирішує його вибірка |
| 50 одночасних, наївний cache-aside | **50** походів у базу |
| 50 одночасних, single-flight | **1** похід (`db-calls=1`) |
| 100 читань теплого кеша | **0** походів (`db-calls-warm=0`) |
| час хвилі | 8–27 мс наївно, ≈24 мс із локом |

Час із локом на цьому стенді **не кращий**: 49 очікувальників сплять по 20 мс (інтервал
опитування), а база з крихітною таблицею витримує 50 однакових `SELECT` за ~10 мс. Лок
економить навантаження на базу (50→1), а не мілісекунди в кожному запиті; на реально
важкому запиті виграш і в часі видно.

### 3. Сесії з rolling TTL

Сесія — ключ `sess:<id>` (JSON) на `redis-queue`, TTL 20 с у демо. Кожен запит проходить
через `GETEX key EX ttl`: читання **і** подовження за одну команду, тож активного
користувача не викине посеред роботи. Демо ганяє справжній HTTP (`node:http` + `fetch`
із cookie), чекає 2 с між запитами (`pttl` перед = 17992, після активності = 19998 →
`ttl-renewed=1`), потім «перезапускає процес» (новий сервер, новий `SessionStore`, нове
зʼєднання) — той самий cookie далі веде в ту саму сесію (`sessions=1`, лічильник візитів
не скинувся). Стан у Redis, не в памʼяті процесу. Власна реалізація на трьох командах
замість `connect-redis` (ESM-only, Node ≥22).

### 4. Rate-limit

Ковзне вікно (ZSET часових міток, один Lua-скрипт: `ZREMRANGEBYSCORE` + `ZCARD` +
`ZADD`, час із `TIME` Redis-а, а не з годинників подів). **Чому ковзне вікно:** сплеск
на межі вікна нам не потрібен — фіксоване вікно пропускає до 2× ліміту навколо границі,
а token bucket свідомо віддає залп. Перевищення → `429` + `Retry-After` (секунди до
звільнення найстарішого слота, ≥1). Недоступний Redis → fail-open (сервіс важливіший за
ліміт). Демо піднімає **два** незалежні екземпляри (окремі зʼєднання й HTTP-сервери),
14 запитів одного клієнта чергуються між ними: `limit=5 allowed=5 blocked=9 status=429
retry-after=1`; лічильник у памʼяті процесу дав би `allowed=10`.

### 5–6. Черга BullMQ

`attempts: 4`, `backoff: { type: 'exponential', delay: 200, jitter: 0.5 }`, `jobId =
recalc-rating-<productId>` (BullMQ забороняє `:` в id), `removeOnComplete: { age: 3600 }`
(**не** `true` — він вимикає дедуплікацію за `jobId`). Планувальник — `upsertJobScheduler`
(двічі підряд = один планувальник; repeatable-API в BullMQ 6 прибрано). Worker має
`maxRetriesPerRequest: null`, Queue — ні (падати швидко). Демо: `added=2 queued=1`
(два `add` з одним `jobId` — одна задача), обробник падає двічі → `attempts=3
completed=1`; після завершення третій `add` теж не створює дубліката (`age`-запас);
`schedulers=1 scheduled-runs=6` за 3 с при `every: 500`. `queue-noeviction=1` читається
з `CONFIG GET maxmemory-policy` черги, `cache-lru=1` — з кеш-інстансу: один інстанс не
може дати обидва.

> Обробник `recalc-rating` у демо — стаб (рахує спроби); у застосунку його
> `recalcRating`-залежність має перерахувати рейтинг у базі й викликати
> `CacheAside.invalidate`. HTTP-контролери Nest лишаються in-memory (як і в hw-22) —
> Redis-шар підключено до CLI/демо-шляху.

### Що станеться, якщо stampede-лок зламається

Лок (`SET NX PX` + token) тут — **оптимізація, не інваріант**. Якщо він зламається (лок
протух під паузою процесу — GC, page fault; Redis перезапустився без AOF; failover
втратив ключ), двоє одночасно вирішать, що вони лідери, і обидва зроблять `SELECT` картки.
Обидва запишуть у кеш **те саме** читання (картка — чиста функція від стану бази),
останній `SET` просто перезапише попередній. Ціна — зайвий читальний запит (кілька
центів на графіку навантаження), стан не псується; без fencing token нам нічого й не
треба, бо немає чого фенсити. Саме тому тут достатньо одного Redis без Redlock.
Той самий `SET NX PX` у ролі захисту бізнес-інваріанта (двічі списати гроші, двічі
зменшити stock) коштував би зіпсованого стану — для такого є транзакція, унікальний
індекс (`idempotency_keys`, `order_receipts.order_id`) або fencing token, який перевіряє
саме сховище. **Лок не замінює ідемпотентність.**

## Grading

Грейдер клонує репозиторій начисто і не має доступу до сховища
конфігурації (хмарний проєкт вимагає особистого логіна) — тому команди,
що ходять у базу, виконуються з `SKIP_VAULT=1`, а `DB_*` беруться з
дев-креденшелів цього ж `docker-compose.yml` (роль `marketplace` — не
секрет, навмисно в git, щоб свіжий клон піднявся однією командою):

```bash
docker compose up -d --wait

export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace DB_PASSWORD=dev_secret_pw DB_NAME=marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npx tsc --noEmit
npm run build

npm run migrate
npm run migrate:show
npm run migrate:revert
npm run migrate

npm run seed
npm run seed

npm run demo:nplus1
npm run report

npm run demo:race
npm run demo:workers
npm run demo:retry
```

### hw-15 (PgBouncer + backup + restore-drill)

Ті самі правила: без сховища, `SKIP_VAULT=1`, дев-креденшели з `docker-compose.yml`.
Скрипти беруть підключення з `$DATABASE_URL` (обгортка `with-secrets.sh` при
`SKIP_VAULT=1` просто виконує команду; без обгортки скрипти теж працюють, якщо
`DATABASE_URL` уже в оточенні). З URL використовуються лише роль і імʼя бази — сам
`pg_dump` іде в контейнер `db` (docker має бути доступний).

```bash
docker compose up -d --wait

# застосунок ходить через PgBouncer — порт 6432
PGPASSWORD=dev_secret_pw psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c "SELECT 1"
PGPASSWORD=pgbouncer_auth_dev_pw psql -h 127.0.0.1 -p 6432 -U pgbouncer_auth -d pgbouncer -c "SHOW POOLS"
grep -E '^\s*pool_mode\s*=\s*transaction' pgbouncer/pgbouncer.ini
grep -E '^(export[[:space:]]+)?(DATABASE_URL|DB_URL)=' .env.example

# наповнити БД, щоб drill мав що звіряти (для порожньої бази MATCH формальний)
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=marketplace DB_PASSWORD=dev_secret_pw DB_NAME=marketplace
export SKIP_VAULT=1
npm ci && npm run build && npm run migrate && npm run seed

export DATABASE_URL=postgres://marketplace:dev_secret_pw@127.0.0.1:6432/marketplace
bash scripts/with-secrets.sh dev bash scripts/backup.sh          # друкує backups/marketplace-<дата>.dump
pg_restore --list backups/marketplace-*.dump | head              # (потрібен pg_restore на хості)
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh   # друкує MATCH
grep -cE '^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|([0-9*/,-]+[[:space:]]+){4}[0-9*/,-]+)[[:space:]]+.*backup' backup.cron
grep -iE 'RTO|RPO' RESTORE-DRILL.md
```

Основний шлях (без `SKIP_VAULT`) усе одно веде у сховище —
`scripts/with-secrets.sh` без цього прапорця робить `infisical run`;
статичний критерій (обгортка зашита в `migrate`/`seed` у `package.json`,
у `src/data-source.ts` немає зашитого пароля) перевіряє це без сховища й
без бази.

### hw-16 (integration/E2E/contract testing)

Без сховища, `SKIP_VAULT=1` не потрібен — жоден із чотирьох npm-скриптів не
ходить через `with-secrets.sh` (testcontainers піднімає власний Postgres,
пароль до якого живе секунди — деталі в розділі
[Тестування (hw-16)](#тестування-hw-16)). Потрібен лише запущений Docker.

```bash
npm ci
npx tsc --noEmit

npm run test:integration          # exit 0, Tests: N passed (N>=6), PASS-рядки видно
grep -rn "PostgreSqlContainer" test/ src/
grep -rniE "duplicate key|unique|2350[0-9]|foreign key|constraint" test/ src/
grep -n "reporters" jest.config.*

npm run test:integration && npm run test:integration   # обидва прогони зелені без ручної чистки

npm run test:e2e                  # exit 0, Tests: N passed (N>=2)
grep -rnE "\b(400|404|409|422)\b|HttpStatus\.(BAD_REQUEST|NOT_FOUND|CONFLICT|UNPROCESSABLE_ENTITY)" test/e2e/

npm run test:contract             # exit 0, генерує pacts/*.json
ls pacts/*.json
grep providerStates pacts/*.json

npm run verify:provider           # exit 0 — справжній застосунок проти контракту
npm run verify:provider 2>&1 | sed -E $'s/\x1b\\[[0-9;]*m//g' | grep -F "has a matching body (OK)"
# рівноцінно без sed: npm run verify:provider 2>&1 | grep -F '"result":"OK"'

# контракт узгоджений зі спекою #9 (заміни <файл> на своє імʼя пакта, якщо інше)
node -e 'const p=require("./pacts/marketplace-web-marketplace-api.json");const spec=require("fs").readFileSync("openapi/openapi.yaml","utf8");const sp=[...spec.matchAll(/^\s+(\/\S*):\s*$/gm)].map(m=>m[1]);const seg=s=>s.split("?")[0].replace(/\/+$/,"").split("/");const fit=(a,b)=>{a=seg(a);b=seg(b);return a.length===b.length&&a.every((x,i)=>/^\{[^}]+\}$/.test(x)?b[i]!=="":x===b[i])};const bad=p.interactions.filter(i=>!sp.some(x=>fit(x,i.request.path)));console.log(bad.length?"НЕМАЄ У СПЕЦІ: "+bad.map(i=>i.request.path).join(", "):"OK");process.exit(bad.length?1:0)'

grep -rn "can-i-deploy" .github/workflows/
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/contract.yml'))"

test -f scripts/with-secrets.sh && grep -q 'SKIP_VAULT' scripts/with-secrets.sh
grep -rnE "PACT_BROKER_TOKEN[[:space:]]*[:=][[:space:]]*['\"][^'\"$]" --include='*.ts' --include='*.js' --include='*.yml' --include='*.yaml' --include='*.json' . | grep -v node_modules
# (порожній вивід — OK)
```

Локальний еквівалент гейту can-i-deploy (unknown -> true) — повна
послідовність команд і реальні виводи з 23.09.2026 у розділі
[Тестування (hw-16) → Локальний еквівалент CI-гейту](#тестування-hw-16)
вище.

### hw-18 (realtime: WebSocket + SSE)

Без сховища — `SKIP_VAULT=1` не потрібен, realtime-шар БД не чіпає взагалі
(products/orders курсового HTTP-шару — in-memory). Потрібен лише піднятий
застосунок (`o1` — замовлення з seed-даних, є завжди):

```bash
npm ci
npm run build
npm start &
sleep 2   # дати застосунку піднятись

# SSE-заголовок
curl -sN --max-time 2 -D - -o /dev/null http://localhost:3000/orders/o1/events | grep -i '^content-type'
# text/event-stream

# Формат подій: паралельно міняємо статус і одразу читаємо потік
( sleep 0.3; curl -s -X PATCH http://localhost:3000/orders/o1/status \
    -H 'content-type: application/json' -d '{"status":"packed"}' >/dev/null ) &
curl -sN --max-time 3 http://localhost:3000/orders/o1/events
# id: 1
# event: order.status
# data: {"id":1,"orderId":"o1","status":"packed","ts":"..."}

# Last-Event-ID: щонайменше 4 зміни статусу (id 1..N, N>=4), тоді
for s in shipped delivered new packed; do
  curl -s -X PATCH http://localhost:3000/orders/o1/status \
    -H 'content-type: application/json' -d "{\"status\":\"$s\"}" >/dev/null
done
curl -sN --max-time 2 -H 'Last-Event-ID: 3' http://localhost:3000/orders/o1/events | grep '^id:' | head -1
# id > 3 (пропущене доїхало, дублів нема)

# Ізоляція кімнат — основний і контрольний прогони
node scripts/realtime-demo.mjs;             echo "exit=$?"
# A_RECEIVED=1 · B_RECEIVED=0 · exit=0
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1 · B_RECEIVED=1 · exit=0

kill %1   # зупинити застосунок, піднятий вище через `npm start &`
```

Trade-offs (таблиця + висновок) — розділ
[Realtime-шар (hw-18) → Trade-offs: WebSocket vs SSE](#realtime-шар-hw-18)
вище; перевірка, що це саме таблиця:

```bash
sec=$(awk 'tolower($0) ~ /^#+ .*trade[ -]?off/{f=1;next} f && /^#+ /{exit} f' README.md)
printf '%s\n' "$sec" | grep -cE '^ *\|? *:?-{3,}'   # >= 1 — рядок-роздільник таблиці
printf '%s\n' "$sec" | grep -c '|'                   # >= 4 — шапка + роздільник + мінімум 2 рядки
```

### hw-19 (RabbitMQ: публікація, ack, DLQ, ідемпотентність)

Ті самі правила: без сховища, `SKIP_VAULT=1`, дев-креденшели з `docker-compose.yml`.
`BROKER_URL` — схема `amqp`, порт **5672** (AMQP; на 15672 — вебморда, не AMQP).
`--wait` обовʼязковий: healthcheck брокера — `rabbitmq-diagnostics -q check_running`.
Демо самі накочують міграції (`order_receipts`) і оголошують топологію.

```bash
docker compose up -d --wait

export BROKER_URL=amqp://app:app@127.0.0.1:5672
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace DB_PASSWORD=dev_secret_pw DB_NAME=marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npx tsc --noEmit
npm run build

npm run demo:publish   # published=5 effect=5 dlq=0 prefetch=10
npm run demo:dlq       # work=0 dlq=1 dlq-reason=rejected
npm run demo:duplicate # deliveries=2 effect=1
```

З активним сховищем `BROKER_URL` береться з Infisical (`dev`) поруч із `DB_*`.

### hw-22 (transactional outbox + ідемпотентність)

Без сховища, `SKIP_VAULT=1`, дев-креденшели з `docker-compose.yml`. Змінна брокера —
`BROKER_URL`, схема `amqp`, порт **5672** (AMQP; на 15672 — вебморда). `--wait`
обовʼязковий. Демо самі накочують міграції (`outbox`, `processed_messages`,
`idempotency_keys`) і оголошують топологію; усі три ходять у базу через
`bash scripts/with-secrets.sh dev …`.

```bash
docker compose up -d --wait

export DATABASE_URL=postgres://marketplace:dev_secret_pw@127.0.0.1:5432/marketplace
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace DB_PASSWORD=dev_secret_pw DB_NAME=marketplace
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npx tsc --noEmit
npm run build

npm run demo:outbox | tee /tmp/o.txt; echo "exit=${PIPESTATUS[0]}"
for k in requests=2 orders=1 outbox=1 published=1 effect=1 processed=1; do
  grep -qx "$k" /tmp/o.txt || echo "НЕМАЄ: $k"
done

npm run demo:crash-write    # write-failed=1 orders=0 outbox=0 published=0 deliveries=0 effect=0

npm run demo:crash-relay | tee /tmp/c.txt; echo "exit=${PIPESTATUS[0]}"
awk -F= '/^deliveries=/{ok=($2>=2)} END{exit !ok}' /tmp/c.txt && echo "deliveries>=2 OK"
for k in applied=1 effect=1 processed=1; do
  grep -qx "$k" /tmp/c.txt || echo "НЕМАЄ: $k"
done
```

### hw-23 (Redis: кеш, сесії, ліміти, черга)

Без сховища, `SKIP_VAULT=1`, дев-креденшели з `docker-compose.yml`. Два Redis:
кеш (`redis://127.0.0.1:6379`, `allkeys-lru`) і черга (`redis://127.0.0.1:6380`,
`noeviction`). `--wait` обовʼязковий. `demo:cache` сам накочує міграції (`reviews`);
усі чотири демо ходять у Redis через `bash scripts/with-secrets.sh dev …`.

```bash
docker compose up -d --wait

export REDIS_URL=redis://127.0.0.1:6379
export REDIS_QUEUE_URL=redis://127.0.0.1:6380
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace DB_PASSWORD=dev_secret_pw DB_NAME=marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npx tsc --noEmit
npm run build

npm run demo:cache | tee /tmp/c.txt; echo "exit=${PIPESTATUS[0]}"
for k in db-calls=1 db-calls-warm=0 cache-lru=1 cache-maxmemory=1; do
  grep -qx "$k" /tmp/c.txt || echo "НЕМАЄ: $k"
done
awk -F= '/^concurrent=/{ok=($2>=20)} END{exit !ok}' /tmp/c.txt && echo "concurrent>=20 OK"
awk -F= '/^warmed=/{ok=($2>=50)}      END{exit !ok}' /tmp/c.txt && echo "warmed>=50 OK"
awk -F= '/^ttl-distinct=/{ok=($2>=5)} END{exit !ok}' /tmp/c.txt && echo "ttl-distinct>=5 OK"

npm run demo:session | tee /tmp/s.txt; echo "exit=${PIPESTATUS[0]}"
for k in sessions=1 in-redis=1 ttl-renewed=1; do
  grep -qx "$k" /tmp/s.txt || echo "НЕМАЄ: $k"
done
awk -F= '/^requests=/{ok=($2>=3)} END{exit !ok}' /tmp/s.txt && echo "requests>=3 OK"

npm run demo:ratelimit | tee /tmp/r.txt; echo "exit=${PIPESTATUS[0]}"
for k in status=429 retry-after=1; do
  grep -qx "$k" /tmp/r.txt || echo "НЕМАЄ: $k"
done
awk -F= '/^instances=/{i=$2} /^limit=/{l=$2} /^allowed=/{a=$2} /^blocked=/{b=$2}
  END{exit !(i>=2 && l>0 && a==l && b>=1)}' /tmp/r.txt && echo "instances/allowed/blocked OK"

npm run demo:queue | tee /tmp/q.txt; echo "exit=${PIPESTATUS[0]}"
for k in completed=1 added=2 queued=1 queue-noeviction=1; do
  grep -qx "$k" /tmp/q.txt || echo "НЕМАЄ: $k"
done
awk -F= '/^attempts=/{ok=($2>=3)} END{exit !ok}' /tmp/q.txt && echo "attempts>=3 OK"
awk -F= '/^schedulers=/{ok=($2>=1)} END{exit !ok}' /tmp/q.txt && echo "schedulers>=1 OK"
awk -F= '/^scheduled-runs=/{ok=($2>=2)} END{exit !ok}' /tmp/q.txt && echo "scheduled-runs>=2 OK"

# кеш і черга — на різних інстансах
grep -qx 'cache-lru=1' /tmp/c.txt && grep -qx 'queue-noeviction=1' /tmp/q.txt \
  && echo "два інстанси OK" || echo "кеш і черга на одному інстансі"
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