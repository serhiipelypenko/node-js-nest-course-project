# hw-12 · Оптимізація запитів: EXPLAIN до і після індексів

Головна таблиця — **`orders`** (300 000 рядків, ~26 МБ / ~3385 сторінок,
дані повністю в `shared_buffers`). Прогін: чистий volume → `db/schema.sql` →
`db/seed.sql` (закінчується `VACUUM (ANALYZE)`) → EXPLAIN «до» → `db/indexes.sql`
→ `ANALYZE;` → EXPLAIN «після».

Числа — з локальної машини (Apple Silicon, Docker, `postgres:16`). `db/seed.sql`
генерує дані через `random()`, тому конкретні мілісекунди й `rows` у кожного
свої — важливий **порядок величини і форма плану** (який вузол зник, куди
поділись buffers).

| Запит | Час до | Час після | Прискорення | План до → після |
|-------|-------:|----------:|------------:|-----------------|
| q1 — замовлення покупця за період | 8.77 ms | 0.10 ms | ~88× | Parallel Seq Scan + Sort → Index Scan |
| q2 — `count(*)` pending за 30 днів | 10.62 ms | 0.19 ms | ~57× | Parallel Seq Scan → Index Only Scan |
| q3 — пошук по `lower(email)`      | 22.77 ms | 0.15 ms | ~150× | Parallel Seq Scan → Bitmap Index Scan |

Індекс під кожен запит (`db/indexes.sql`):

| Запит | Індекс | Тип |
|-------|--------|-----|
| q1 | `idx_orders_buyer_created (buyer_id, created_at DESC)` | складений |
| q2 | `idx_orders_pending_created (created_at) WHERE status = 'pending'` | **partial** |
| q3 | `idx_orders_customer_email_lower (lower(customer_email))` | **expression** |

---

## q1 — «Мої замовлення за останні 90 днів»

```sql
SELECT id, status, total_amount, created_at
FROM orders
WHERE buyer_id = 12345
  AND created_at >= now() - interval '90 days'
ORDER BY created_at DESC
LIMIT 20;
```

### До

```
 Limit  (cost=6885.21..6885.22 rows=2 width=28) (actual time=7.064..8.740 rows=3 loops=1)
   Buffers: shared hit=3388
   ->  Sort  (cost=6885.21..6885.22 rows=2 width=28) (actual time=7.063..8.739 rows=3 loops=1)
         Sort Key: created_at DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=3388
         ->  Gather  (cost=1000.00..6885.20 rows=2 width=28) (actual time=6.565..8.719 rows=3 loops=1)
               Workers Planned: 2
               Workers Launched: 2
               Buffers: shared hit=3385
               ->  Parallel Seq Scan on orders  (cost=0.00..5885.00 rows=1 width=28) (actual time=4.065..5.592 rows=1 loops=3)
                     Filter: ((buyer_id = 12345) AND (created_at >= (now() - '90 days'::interval)))
                     Rows Removed by Filter: 99999
                     Buffers: shared hit=3385
 Planning:
   Buffers: shared hit=97
 Planning Time: 0.374 ms
 Execution Time: 8.771 ms
```

### Після

```
 Limit  (cost=0.43..12.47 rows=2 width=28) (actual time=0.054..0.067 rows=3 loops=1)
   Buffers: shared hit=6 read=3
   ->  Index Scan using idx_orders_buyer_created on orders  (cost=0.43..12.47 rows=2 width=28) (actual time=0.053..0.066 rows=3 loops=1)
         Index Cond: ((buyer_id = 12345) AND (created_at >= (now() - '90 days'::interval)))
         Buffers: shared hit=6 read=3
 Planning:
   Buffers: shared hit=171 read=3
 Planning Time: 0.611 ms
 Execution Time: 0.100 ms
```

**Що змінилось.** `Parallel Seq Scan`, який читав усі 3385 сторінок таблиці й
відкидав по 99 999 рядків на воркера, замінився на `Index Scan` по
`(buyer_id, created_at DESC)`: обидві умови пішли в `Index Cond`, `buffers`
впали з 3385 до 9, а вузол `Sort` зник зовсім — B-tree уже впорядкований за
`created_at DESC`, тож `ORDER BY … LIMIT 20` бере готові рядки з голови індексу.

---

## q2 — «Скільки замовлень зависло в pending за 30 днів»

```sql
SELECT count(*)
FROM orders
WHERE status = 'pending'
  AND created_at >= now() - interval '30 days';
```

### До

```
 Finalize Aggregate  (cost=6886.41..6886.43 rows=1 width=8) (actual time=8.963..10.564 rows=1 loops=1)
   Buffers: shared hit=3385
   ->  Gather  (cost=6886.20..6886.41 rows=2 width=8) (actual time=8.906..10.561 rows=3 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=3385
         ->  Partial Aggregate  (cost=5886.20..5886.21 rows=1 width=8) (actual time=7.411..7.412 rows=1 loops=3)
               Buffers: shared hit=3385
               ->  Parallel Seq Scan on orders  (cost=0.00..5885.00 rows=480 width=0) (actual time=0.022..7.388 rows=361 loops=3)
                     Filter: ((status = 'pending'::text) AND (created_at >= (now() - '30 days'::interval)))
                     Rows Removed by Filter: 99639
                     Buffers: shared hit=3385
 Planning:
   Buffers: shared hit=77
 Planning Time: 0.312 ms
 Execution Time: 10.615 ms
```

### Після

```
 Aggregate  (cost=39.01..39.02 rows=1 width=8) (actual time=0.153..0.153 rows=1 loops=1)
   Buffers: shared hit=1 read=5
   ->  Index Only Scan using idx_orders_pending_created on orders  (cost=0.29..36.17 rows=1136 width=0) (actual time=0.031..0.104 rows=1083 loops=1)
         Index Cond: (created_at >= (now() - '30 days'::interval))
         Heap Fetches: 0
         Buffers: shared hit=1 read=5
 Planning:
   Buffers: shared hit=139
 Planning Time: 0.494 ms
 Execution Time: 0.185 ms
```

**Що змінилось.** `Parallel Seq Scan` по всій таблиці (3385 сторінок, ~99 600
відкинутих рядків на воркера) замінився на `Index Only Scan` по **частковому**
індексу: `status = 'pending'` уже «вшитий» у предикат індексу, тож у ньому
лежать лише ~27 тис. потрібних записів, і в скан пішло 6 сторінок замість 3385.
`Heap Fetches: 0` — відповідь цілком з індексу, у таблицю не заходили жодного
разу (це заслуга `VACUUM` у кінці сіду, що виставив visibility map).

---

## q3 — «Знайти замовлення за email» (пошук без урахування регістру)

```sql
SELECT id, buyer_id, status, total_amount, created_at
FROM orders
WHERE lower(customer_email) = 'user4242@example.com';
```

### До

```
 Gather  (cost=1000.00..6410.00 rows=1500 width=36) (actual time=0.198..22.715 rows=11 loops=1)
   Workers Planned: 2
   Workers Launched: 2
   Buffers: shared hit=3385
   ->  Parallel Seq Scan on orders  (cost=0.00..5260.00 rows=625 width=36) (actual time=4.240..19.151 rows=4 loops=3)
         Filter: (lower(customer_email) = 'user4242@example.com'::text)
         Rows Removed by Filter: 99996
         Buffers: shared hit=3385
 Planning:
   Buffers: shared hit=72
 Planning Time: 0.268 ms
 Execution Time: 22.769 ms
```

### Після

```
 Bitmap Heap Scan on orders  (cost=4.54..61.77 rows=15 width=36) (actual time=0.057..0.103 rows=11 loops=1)
   Recheck Cond: (lower(customer_email) = 'user4242@example.com'::text)
   Heap Blocks: exact=11
   Buffers: shared hit=11 read=3
   ->  Bitmap Index Scan on idx_orders_customer_email_lower  (cost=0.00..4.54 rows=15 width=0) (actual time=0.047..0.047 rows=11 loops=1)
         Index Cond: (lower(customer_email) = 'user4242@example.com'::text)
         Buffers: shared read=3
 Planning:
   Buffers: shared hit=130
 Planning Time: 0.461 ms
 Execution Time: 0.154 ms
```

**Що змінилось.** `lower()` над колонкою робив будь-який звичайний індекс
неробочим, тому був `Parallel Seq Scan` по всіх 3385 сторінках. **Expression**-
індекс тримає в дереві сам результат `lower(customer_email)`, тож умова пішла
в `Index Cond`: `Bitmap Index Scan` дістав 3 сторінки індексу, `Bitmap Heap
Scan` — 11 сторінок таблиці рівно під знайдені рядки; `buffers` 3385 → 14.

---

## Аудит: чи всі індекси окупились

Після прогону всіх трьох запитів:

```
          indexrelname           | idx_scan
---------------------------------+----------
 idx_orders_buyer_created        |        1
 idx_orders_customer_email_lower |        1
 idx_orders_pending_created      |        1
```

Кожен із трьох доданих індексів використаний. `users_email_key` /
`products_sku_key` показують `idx_scan = 0`, але це індекси під
`UNIQUE`-констрейнти (їх тримає схема, а не запити), а не «індекси про запас» —
під ніж вони не йдуть.
