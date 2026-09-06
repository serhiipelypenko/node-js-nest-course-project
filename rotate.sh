#!/usr/bin/env bash
# Ротація пароля ролі БД БЕЗ рестарту застосунку.
#
# Порядок кроків критичний (AWS "alternating users" / rotation strategies):
#   1. ALTER ROLE  — Postgres уже знає новий пароль
#   2. файл-секрет — застосунок почне давати новий пароль на НАСТУПНЕ зʼєднання
#   3. pg_terminate_backend — рвемо старі зʼєднання, пул відкриває нові й
#      перечитує файл (password: async () => readFile(...) у pg.Pool)
#
# Між кроком 1 і 2 є мікровікно, коли живі старі конекти (зі старим паролем)
# і Postgres знає новий — старі конекти НЕ рвуться, тож застосунок працює.
set -euo pipefail

ROLE="marketplace"
DB="marketplace"
DB_SVC="db"
PW_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"

NEW_PW="$(openssl rand -hex 24)"

psql_su() {
  # superuser postgres через unix-сокет у контейнері -> local trust, пароль не потрібен
  docker compose exec -T "$DB_SVC" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" "$@"
}

echo "1/3  ALTER ROLE ${ROLE} WITH PASSWORD ..."
psql_su -c "ALTER ROLE ${ROLE} WITH PASSWORD '${NEW_PW}';"

echo "2/3  переписую ${PW_FILE} (той самий inode -> bind-mount виживає) ..."
printf '%s' "${NEW_PW}" > "${PW_FILE}"

echo "3/3  pg_terminate_backend для старих зʼєднань ролі ${ROLE} ..."
psql_su -c "SELECT pg_terminate_backend(pid)
              FROM pg_stat_activity
             WHERE usename = '${ROLE}' AND pid <> pg_backend_pid();" >/dev/null

echo "OK: пароль зротовано. Застосунок не перезапускався — перевір uptime у GET /health."
