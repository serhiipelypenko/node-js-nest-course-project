# Спільне для backup.sh / restore-drill.sh — підключається через `source`.
#
# Рядок підключення береться з оточення — його наповнює scripts/with-secrets.sh
# (сховище з ДЗ #11 або SKIP_VAULT=1 у грейдера):
#   1. $DATABASE_URL, якщо заданий (postgres://user:pass@host:port/db);
#   2. інакше збираємо його з DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME —
#      це ті самі змінні, що читає src/data-source.ts (hw-13/14).
# Нового env-файла не заводимо.
#
# На виході: DATABASE_URL, DB_APP_USER, DB_APP_NAME.
#
# ⚠ Ні host, ні port з URL скрипти НЕ використовують: pg_dump і psql-звірка
# ходять у контейнер `db` через unix-сокет (`docker compose exec`), тобто в
# обхід PgBouncer. Бекап навмисно знімається з самого Postgres: pg_dump у
# transaction mode — зайвий ризик (довга REPEATABLE READ-транзакція + SET-и
# сесії), а пулер тут нічого не дає. З URL потрібні лише роль і імʼя бази.

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -n "${DB_USER:-}" ] && [ -n "${DB_NAME:-}" ]; then
    DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD:-}@${DB_HOST:-127.0.0.1}:${DB_PORT:-6432}/${DB_NAME}"
  else
    echo "✗ Немає підключення: задай DATABASE_URL (або DB_USER/DB_NAME) — його дає" >&2
    echo "  scripts/with-secrets.sh <env> (сховище) або SKIP_VAULT=1 + export вручну." >&2
    exit 1
  fi
fi

if [[ "$DATABASE_URL" =~ ^postgres(ql)?://([^:@/]+)(:[^@]*)?@[^/]+/([^?]+) ]]; then
  DB_APP_USER="${BASH_REMATCH[2]}"
  DB_APP_NAME="${BASH_REMATCH[4]}"
else
  echo "✗ DATABASE_URL не схожий на postgres://user:pass@host:port/db" >&2
  exit 1
fi

# Сервіс Postgres у docker-compose.yml і тека бекапів (поза контейнером).
DB_SERVICE="${DB_SERVICE:-db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
