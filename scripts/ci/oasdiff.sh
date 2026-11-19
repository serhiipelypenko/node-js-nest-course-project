#!/usr/bin/env bash
# hw-32: сходинка 2 «Контракт» — oasdiff breaking між базовою і новою спекою. Код виходу ≠ 0, якщо є зміна рівня ERR
# (ламає того, хто вже живе на v1). Один скрипт для конвеєра й для demo:gates.
#   bash scripts/ci/oasdiff.sh <base.yaml> <head.yaml>      (шляхи — відносно кореня репо)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ "$#" -eq 2 ] || { echo "використання: $0 <base.yaml> <head.yaml>" >&2; exit 2; }

OASDIFF_IMAGE="${OASDIFF_IMAGE:-tufin/oasdiff:v1.32.1}"
if command -v oasdiff >/dev/null 2>&1; then
  exec oasdiff breaking "$1" "$2" --fail-on ERR
fi
command -v docker >/dev/null 2>&1 || { echo "✗ немає ні oasdiff, ні docker" >&2; exit 2; }
exec docker run --rm -v "$PWD:/w" -w /w "$OASDIFF_IMAGE" breaking "$1" "$2" --fail-on ERR
