# hw-09 — Marketplace API: контракт + рантайм-валідація

Обраний варіант: **Б — runtime-валідація на кордоні**.

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
npm run build
npm start
# або для розробки: npm run start:dev
```

Сервер піднімається на `http://localhost:3000` (можна змінити через `PORT`).

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

```bash
docker compose up --build
```