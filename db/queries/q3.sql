-- q3 · "Знайти всі замовлення за email" — інструмент підтримки. Пошта в базі
-- у змішаному регістрі ('User4242@Example.com'), тому пошук іде через
-- lower(customer_email) = lower(введене).
-- Чиста схема: навіть якби був звичайний індекс по customer_email, функція
-- lower() над колонкою його вимкне -> Seq Scan по всіх 300k рядків.
SELECT id, buyer_id, status, total_amount, created_at
FROM orders
WHERE lower(customer_email) = 'user4242@example.com';
