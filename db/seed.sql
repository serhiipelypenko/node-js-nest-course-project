-- hw-12 · Наповнення даними. Прогін: psql -f db/seed.sql
--
-- Обсяг: 300 000 рядків у головній таблиці orders (вимога — >= 100 000).
-- На тисячі рядків EXPLAIN нічого не покаже: планер справедливо візьме
-- Seq Scan за будь-яких індексів. Треба обсяг.
--
-- Розподіли перекошені, як у житті:
--   * статуси НЕ 20/20/20/20/20, а 62/20/9/6/3 (paid переважає);
--   * created_at — випадкова точка за останні 730 днів;
--   * ~15 замовлень на покупця в середньому (300k / 20k).
--
-- random() дає різні дані щоразу — це нормально, критерії від точних чисел
-- не залежать, важливі перекіс і обсяг.
--
-- Файл НЕ загорнутий у BEGIN/COMMIT: у кінці стоїть VACUUM, який не може
-- виконуватись у транзакційному блоці.

TRUNCATE order_items, orders, products, users RESTART IDENTITY CASCADE;

-- 20 000 покупців.
INSERT INTO users (email, full_name, created_at)
SELECT
  'user' || g || '@example.com',
  'User ' || g,
  now() - (random() * interval '900 days')
FROM generate_series(1, 20000) AS g;

-- 2 000 товарів, ~10% знятих з продажу (is_active = false).
INSERT INTO products (sku, name, price, is_active, created_at)
SELECT
  'SKU-' || lpad(g::text, 6, '0'),
  'Product ' || g,
  round((random() * 490 + 10)::numeric, 2),
  random() < 0.90,
  now() - (random() * interval '700 days')
FROM generate_series(1, 2000) AS g;

-- 300 000 замовлень. customer_email навмисно у змішаному регістрі
-- ('User4242@Example.com') — щоб q3 з lower() без expression-індексу
-- був змушений у Seq Scan.
INSERT INTO orders (buyer_id, customer_email, status, total_amount, created_at)
SELECT
  s.buyer_id,
  'User' || s.buyer_id || '@Example.com',
  CASE
    WHEN s.r < 0.62 THEN 'paid'
    WHEN s.r < 0.82 THEN 'shipped'
    WHEN s.r < 0.91 THEN 'pending'
    WHEN s.r < 0.97 THEN 'cancelled'
    ELSE                 'refunded'
  END,
  round((random() * 995 + 5)::numeric, 2),
  now() - (random() * interval '730 days')
FROM (
  SELECT (random() * 19999)::int + 1 AS buyer_id,
         random()                     AS r
  FROM generate_series(1, 300000)
) AS s;

-- 1–3 позиції на замовлення (600k рядків рівно: 1 + id % 3). Ціна позиції =
-- поточна ціна товару (узгоджено з каталогом через FK на products).
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  o.id,
  gs.pid,
  (random() * 4)::int + 1,
  (SELECT price FROM products WHERE id = gs.pid)
FROM orders AS o
CROSS JOIN LATERAL (
  SELECT (random() * 1999)::int + 1 AS pid
  FROM generate_series(1, 1 + (o.id % 3)) AS n
) AS gs;

-- VACUUM (ANALYZE), а НЕ просто ANALYZE. ANALYZE дає планеру статистику, але
-- visibility map виставляє саме VACUUM. Без неї Index Only Scan усе одно лізе
-- в таблицю за кожним рядком (Heap Fetches: N у плані), і buffers "після" в
-- db/OPTIMIZATIONS.md були б у сотні разів гірші, ніж могли б. Після
-- bulk-load VACUUM (ANALYZE) роблять і в житті.
VACUUM (ANALYZE) users, products, orders, order_items;

SELECT 'users'       AS table, count(*) FROM users
UNION ALL SELECT 'products',    count(*) FROM products
UNION ALL SELECT 'orders',      count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items;

SELECT status, count(*),
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM orders
GROUP BY status
ORDER BY count(*) DESC;
