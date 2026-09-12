-- hw-12 · Дата-шар Marketplace API — схема.
-- Застосовується на чисту базу однією командою: psql -f db/schema.sql
--
-- Рішення по типах:
--   * гроші — numeric(12,2), НЕ float: округлення float ламає суми;
--   * час — timestamptz, НЕ timestamp: без таймзони "коли саме" — здогадка;
--   * id — bigint GENERATED ALWAYS AS IDENTITY, НЕ serial: identity не має
--     проблем serial з правами на sequence і з ручним INSERT у PK.
--
-- Порядок DROP — від залежних до батьківських (order_items -> orders ->
-- products/users), щоб FOREIGN KEY не блокував повторний прогін.

DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;

-- Покупці. email унікальний — це природний ключ входу в систему.
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text        NOT NULL UNIQUE,
  full_name  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Каталог товарів. sku — артикул, теж унікальний. price >= 0: від'ємна
-- ціна — це не знижка, це брехня в даних.
CREATE TABLE products (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku        text          NOT NULL UNIQUE,
  name       text          NOT NULL,
  price      numeric(12,2) NOT NULL CHECK (price >= 0),
  is_active  boolean       NOT NULL DEFAULT true,
  created_at timestamptz   NOT NULL DEFAULT now()
);

-- Замовлення — головна таблиця домену (данні заповнює db/seed.sql).
--   buyer_id       -> FOREIGN KEY на users;
--   customer_email — знімок пошти на момент замовлення (у життєвому циклі
--                    користувач може змінити email, а в замовленні лишається
--                    той, на який його оформили). Навмисно у змішаному
--                    регістрі — на цьому будується q3 (пошук через lower()).
--   status         — CHECK-перелік: значення поза списком у базу не потрапить.
CREATE TABLE orders (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id       bigint        NOT NULL REFERENCES users (id),
  customer_email text          NOT NULL,
  status         text          NOT NULL
                 CHECK (status IN ('pending', 'paid', 'shipped',
                                   'cancelled', 'refunded')),
  total_amount   numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  created_at     timestamptz   NOT NULL DEFAULT now()
);

-- Позиції замовлення — рядкові товари.
--   order_id   -> FOREIGN KEY на orders, ON DELETE CASCADE (видалили
--                 замовлення — його позиції їдуть слідом);
--   product_id -> FOREIGN KEY на products (без CASCADE: товар, на який є
--                 позиції, просто так не видалити);
--   quantity > 0, unit_price >= 0 — CHECK там, де нуль/мінус безглуздий.
CREATE TABLE order_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id bigint        NOT NULL REFERENCES products (id),
  quantity   int           NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0)
);

-- Разом: 4 таблиці, 3 FOREIGN KEY (orders.buyer_id, order_items.order_id,
-- order_items.product_id). Жодного індексу, крім тих, що дають PRIMARY KEY та
-- UNIQUE — це навмисно: цю проблему (Seq Scan) у db/queries/*.sql має бути видно на
-- чистій схемі, а лікування живе в db/indexes.sql.
