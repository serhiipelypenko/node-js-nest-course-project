#!/usr/bin/env bash
# hw-28: генератор навантаження. Пише РЯДОК НА КОЖЕН ЗАПИТ — лише код відповіді.
# Жодних висновків тут нема: класифікацію рахує той, хто читає файл.
#
#   load.sh <url> <out-file> <stop-file> [workers]
#
# Працює, доки не зʼявиться stop-file. curl-код 000 = відповіді не було (зʼєднання не
# встановилось або обірвалось): у NodePort напряму збій виглядає саме так, а не як 5xx.
set -uo pipefail
URL="$1"; OUT="$2"; STOP="$3"; WORKERS="${4:-4}"

: > "$OUT"
trap 'kill $(jobs -p) 2>/dev/null' EXIT
for _ in $(seq 1 "$WORKERS"); do
  (
    while [ ! -e "$STOP" ]; do
      code="$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$URL" 2>/dev/null)" || true
      echo "${code:-000}" >> "$OUT"
    done
  ) &
done
wait
