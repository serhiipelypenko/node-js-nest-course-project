-- q1 · "Мої замовлення за останні 90 днів" — сторінка історії покупця.
-- API: GET /orders?buyer=<id> (фільтр по власнику + період, свіжі згори).
-- Чиста схема: buyer_id не проіндексований -> Seq Scan по всіх 300k рядків
-- заради ~5 рядків цього покупця, плюс окремий вузол Sort під ORDER BY.
SELECT id, status, total_amount, created_at
FROM orders
WHERE buyer_id = 12345
  AND created_at >= now() - interval '90 days'
ORDER BY created_at DESC
LIMIT 20;
