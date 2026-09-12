-- hw-12 · Мінімальний набір індексів, що лікує всі три запити. Один запит —
-- один індекс, нічого "про запас": кожен зайвий індекс — це диск і
-- повільніший INSERT/UPDATE. Аудит наприкінці:
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0;
--
-- Прогін: psql -f db/indexes.sql  (далі ANALYZE; — статистику по нових індексах)

-- q1: рівність по buyer_id + діапазон і сортування по created_at.
-- Правило складеного індексу: рівність ліворуч, діапазон праворуч.
-- created_at DESC збігається з ORDER BY -> B-tree віддає рядки вже
-- відсортованими, окремий вузол Sort зникає.
CREATE INDEX idx_orders_buyer_created
  ON orders (buyer_id, created_at DESC);

-- q2: партковий (partial) індекс лише по pending-рядках (~9% таблиці).
-- Предикат WHERE status = 'pending' у визначенні індексу означає, що в дереві
-- лежать тільки потрібні рядки; для інших статусів цього індексу просто немає
-- -> ~10x менше за повний індекс по (status, created_at), а q2 покриває
-- повністю (count(*) -> Index Only Scan).
CREATE INDEX idx_orders_pending_created
  ON orders (created_at)
  WHERE status = 'pending';

-- q3: expression-індекс. У звичайному B-tree по customer_email лежать
-- значення 'User4242@Example.com'; пошук по lower(customer_email) їх не
-- знайде. Тут у дереві лежить сам результат lower() — і умова запиту
-- лягає в Index Cond.
CREATE INDEX idx_orders_customer_email_lower
  ON orders (lower(customer_email));

ANALYZE orders;
