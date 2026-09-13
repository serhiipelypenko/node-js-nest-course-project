#!/usr/bin/env bash
# Ін'єкція секретів БД для CLI-скриптів hw-13 дата-шару (migrate/seed/
# demo:nplus1/report) — той самий патерн, що лекція 11: infisical run кладе
# секрети в env ДОЧІРНЬОГО процесу, на диск нічого не пишеться.
#
#   bash scripts/with-secrets.sh dev npm run migrate
#   bash scripts/with-secrets.sh dev env                 # подивитись, що інʼєктнулось
#
# ⚠ Робочий каталог НЕ міняємо — команду треба виконати там, звідки її
#   запустили (npm run migrate і подібні викликають цей скрипт як обгортку).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true

[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"
if [ ! -f "$CREDS" ]; then
  echo "✗ Немає $CREDS — залогінься в сховище (infisical init) або постав SKIP_VAULT=1, якщо DB_* вже в оточенні." >&2
  exit 1
fi

set -a; . "$CREDS"; set +a

# Токен машини кешуємо на 1 год: інакше кожен виклик migrate/seed/report —
# зайвий раунд-тріп до сховища.
TOKEN_CACHE="$ROOT/.secrets/infisical-token"
if [ -f "$TOKEN_CACHE" ] && [ -n "$(find "$TOKEN_CACHE" -mmin -60 2>/dev/null)" ]; then
  INFISICAL_TOKEN="$(cat "$TOKEN_CACHE")"
else
  INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --domain="$INFISICAL_URL" --silent --plain)"
  (umask 077; printf '%s' "$INFISICAL_TOKEN" > "$TOKEN_CACHE")
fi
export INFISICAL_TOKEN

# set -a вище зробив clientSecret ЕКСПОРТОВАНОЮ змінною — прибираємо, щоб
# довгоживучий ключ від усього сховища не поїхав у env дочірнього процесу.
unset INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET

# --projectId обовʼязковий при machine-identity-авторизації; --project-config-dir
# вказує на корінь репо, інакше CLI шукає .infisical.json угору по дереву.
exec infisical run \
  --domain="$INFISICAL_URL" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --project-config-dir="$ROOT" \
  --env="$ENV_SLUG" \
  --silent \
  -- "$@"
