#!/usr/bin/env bash
# hw-15 — restore-drill: бекап, який ніколи не відновлювали, — не бекап.
#
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
#   (грейдер: SKIP_VAULT=1 + export DATABASE_URL=..., див. README «Grading»)
#
# Що робить:
#   1. бере ОСТАННІЙ дамп із backups/ (той, що зробив backup.sh)
#   2. знімає контрольні значення з живої бази: кількість рядків у кожній
#      таблиці + агрегат sum(total_amount) по ключовій таблиці orders
#   3. піднімає ЧИСТИЙ контейнер Postgres (docker run, той самий образ, що й db,
#      без bind-mount-ів; том — анонімний, тобто новий і порожній)
#   4. pg_restore дампа в нього + ті самі контрольні значення після
#   5. друкує MATCH (exit 0) або MISMATCH (exit 1) і виміряні часи (RTO)
#
# Контейнер drill-у скрипт сам створює і сам прибирає (trap EXIT) разом із
# томом — повторний запуск теж стартує з порожнього.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib-conn.sh

DRILL_NAME="marketplace-restore-drill"

# Час у мілісекундах: EPOCHREALTIME є з bash 5, на macOS-овому bash 3.2 — perl.
# (Рахунок у секундах через $SECONDS давав би «0 с» — це округлення, а не
# вимірювання.)
if [ -n "${EPOCHREALTIME:-}" ]; then
  now_ms() { local t="${EPOCHREALTIME/[.,]/}"; echo "${t:0:${#t}-3}"; }
else
  now_ms() { perl -MTime::HiRes -e 'printf("%.0f\n", Time::HiRes::time()*1000)'; }
fi
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }

cleanup() { docker rm -fv "$DRILL_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ── 1. останній дамп ────────────────────────────────────────────────────────
DUMP="$(ls -1t "$BACKUP_DIR"/"${DB_APP_NAME}"-*.dump 2>/dev/null | head -1 || true)"
[ -n "$DUMP" ] || { echo "✗ У $BACKUP_DIR немає дампів — спершу bash scripts/backup.sh" >&2; exit 1; }
DUMP_BYTES="$(wc -c < "$DUMP" | tr -d ' ')"
DUMP_AGE_S=$(( $(date +%s) - $(stat -f %m "$DUMP" 2>/dev/null || stat -c %Y "$DUMP") ))
echo "━━━ 1. Дамп: $DUMP ($(du -h "$DUMP" | cut -f1), вік $DUMP_AGE_S с) ━━━"

# ── 2. контрольні значення: функція, що виконує SQL у ПОТРІБНОМУ контейнері ──
# $1 = "compose" (живий db) | "drill" (контейнер drill-у); $2 = SQL
q() {
  if [ "$1" = "compose" ]; then
    docker compose exec -T "$DB_SERVICE" psql -U "$DB_APP_USER" -d "$DB_APP_NAME" -Atc "$2"
  else
    docker exec -i "$DRILL_NAME" psql -U "$DB_APP_USER" -d "$DB_APP_NAME" -Atc "$2"
  fi
}

# count(*) кожної таблиці public без знання схеми наперед (query_to_xml).
ROWS_SQL="SELECT coalesce(string_agg(table_name || '=' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text,
  ', ' ORDER BY table_name), '(таблиць немає)')
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
AGG_SQL="SELECT count(*) || ' рядків, sum(total_amount)=' || coalesce(sum(total_amount), 0) FROM orders"

# ⚠ EXISTS перевіряємо окремо: запит до відсутньої orders падає ще на плануванні.
control() {
  local rows agg has_orders
  rows="$(q "$1" "$ROWS_SQL")"
  has_orders="$(q "$1" "SELECT to_regclass('public.orders') IS NOT NULL")"
  if [ "$has_orders" = "t" ]; then agg="$(q "$1" "$AGG_SQL")"; else agg="(таблиці orders немає)"; fi
  printf 'таблиці: %s\norders:   %s' "$rows" "$agg"
}

echo "━━━ 2. Контрольні значення живої бази ━━━"
BEFORE="$(control compose)"
echo "$BEFORE" | sed 's/^/  /'
case "$BEFORE" in
  *"(таблиць немає)"*|*"(таблиці orders немає)"*|*"orders:   0 рядків"*)
    echo "  ⚠ база порожня — звірка формально пройде, але нічого не доводить." >&2
    echo "    Спершу: npm run build && npm run migrate && npm run seed" >&2 ;;
esac

# ── 3. чистий контейнер ─────────────────────────────────────────────────────
echo "━━━ 3. Чистий контейнер $DRILL_NAME ━━━"
cleanup   # залишок від обірваного попереднього запуску
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q "$DB_SERVICE")")"

T_START=$(now_ms)
docker run -d --name "$DRILL_NAME" \
  -e POSTGRES_USER="$DB_APP_USER" -e POSTGRES_DB="$DB_APP_NAME" -e POSTGRES_PASSWORD=drill \
  "$IMAGE" >/dev/null
# Entrypoint образу спершу піднімає ТИМЧАСОВИЙ сервер (лише unix-сокет) для
# initdb, потім перезапускає справжній. Чекаємо по TCP — він з'являється тільки
# у справжнього, інакше pg_restore потрапив би на тимчасовий і обірвався.
for _ in $(seq 1 60); do
  docker exec "$DRILL_NAME" psql -h 127.0.0.1 -U "$DB_APP_USER" -d "$DB_APP_NAME" -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 0.5
done
UP_MS=$(( $(now_ms) - T_START ))

VOL="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$DRILL_NAME")"
TABLES="$(q drill "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
echo "  том ${VOL:0:12}… створений щойно; таблиць у чистій базі: $TABLES (має бути 0)"
[ "$TABLES" = "0" ] || { echo "✗ база drill-у не порожня — drill не має сенсу" >&2; exit 1; }
echo "  контейнер піднято за $(secs "$UP_MS") с"

# ── 4. pg_restore + звірка ──────────────────────────────────────────────────
# --no-owner/--no-acl: у чистому контейнері немає ролі pgbouncer_auth та інших
# власників, на яких посилаються GRANT-и з дампа; дані й схема від цього не
# залежать.
echo "━━━ 4. pg_restore + звірка ━━━"
T_RESTORE=$(now_ms)
docker exec -i "$DRILL_NAME" pg_restore -U "$DB_APP_USER" -d "$DB_APP_NAME" \
  --no-owner --no-acl --exit-on-error < "$DUMP"
RESTORE_MS=$(( $(now_ms) - T_RESTORE ))
AFTER="$(control drill)"
echo "$AFTER" | sed 's/^/  /'

TOTAL_MS=$(( $(now_ms) - T_START ))

echo "━━━ 5. Результат ━━━"
echo "  розмір дампу:              $DUMP_BYTES байт"
echo "  підйом чистого контейнера: $(secs "$UP_MS") с"
echo "  pg_restore:                $(secs "$RESTORE_MS") с"
echo "  RTO drill-у (контейнер + restore + звірка): $(secs "$TOTAL_MS") с"
echo "  вік використаного дампу:   $DUMP_AGE_S с (RPO розкладу «щоночі» = до 24 год)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "MATCH — дані повернулись: кількість рядків і агрегат збігаються"
else
  echo "MISMATCH — після відновлення інші значення:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi
