-- q2 · "Скільки замовлень зависло в pending за останні 30 днів" — віджет
-- адмінки / фонова джоба, що добиває неоплачені.
-- pending — лише ~9% таблиці, але на чистій схемі status не проіндексований
-- -> Seq Scan по всіх 300k рядків, щоб порахувати ~800.
SELECT count(*)
FROM orders
WHERE status = 'pending'
  AND created_at >= now() - interval '30 days';
