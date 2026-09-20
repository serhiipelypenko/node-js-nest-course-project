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
воно вказує на базу цього ДЗ. Нового env-файла з рядком підключення не
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

Основний шлях (без `SKIP_VAULT`) усе одно веде у сховище —
`scripts/with-secrets.sh` без цього прапорця робить `infisical run`;
статичний критерій (обгортка зашита в `migrate`/`seed` у `package.json`,
у `src/data-source.ts` немає зашитого пароля) перевіряє це без сховища й
без бази.

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