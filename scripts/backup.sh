#!/usr/bin/env bash
# hw-15 — бекап бази курсового: pg_dump -Fc -> файл із датою в імені -> локальна
# тека backups/ ПОЗА контейнером (bind на хості, у git не потрапляє).
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh
#   (грейдер: SKIP_VAULT=1 + export DATABASE_URL=..., див. README «Grading»)
#
# Остання рядок stdout — шлях до створеного файла (його бере restore-drill.sh).
# Запускається з кореня репо, але й з cron працює: спершу cd у корінь.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib-conn.sh

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"   # ротація: старші за N днів видаляємо
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
FILE="$BACKUP_DIR/${DB_APP_NAME}-${STAMP}.dump"
PARTIAL="$FILE.partial"

# Пишемо в .partial і перейменовуємо лише після успіху: обірваний pg_dump
# (kill, повний диск) не залишає файл, схожий на справжній бекап — його потім
# міг би підхопити restore-drill як «останній».
trap 'rm -f "$PARTIAL"' EXIT

# -T: без TTY (cron). pg_dump іде через unix-сокет контейнера db, у обхід
# PgBouncer (чому — див. scripts/lib-conn.sh). -Fc = custom format: стиснений,
# з TOC, вибіркове відновлення pg_restore-ом.
docker compose exec -T "$DB_SERVICE" \
  pg_dump -U "$DB_APP_USER" -d "$DB_APP_NAME" -Fc > "$PARTIAL"

[ -s "$PARTIAL" ] || { echo "✗ pg_dump створив порожній файл" >&2; exit 1; }

# Файл має бути валідним -Fc-архівом: pg_restore --list читає його TOC.
ENTRIES="$(docker compose exec -T "$DB_SERVICE" pg_restore --list < "$PARTIAL" | grep -c '^[0-9]')"
[ "$ENTRIES" -gt 0 ] || { echo "✗ у дампі немає жодного обʼєкта (TOC порожній)" >&2; exit 1; }

mv "$PARTIAL" "$FILE"

find "$BACKUP_DIR" -maxdepth 1 -name "${DB_APP_NAME}-*.dump" -mtime "+${KEEP_DAYS}" -delete

SIZE="$(du -h "$FILE" | cut -f1)"
echo "backup: $ENTRIES обʼєктів у TOC, $SIZE"
echo "$FILE"
