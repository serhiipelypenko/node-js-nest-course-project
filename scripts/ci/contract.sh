#!/usr/bin/env bash
# hw-32: сходинка 2 «Контракт» у конвеєрі — oasdiff по спеці з #9: поточна проти бази (main / попередній коміт).
# Ловить «цей PR зламав того, хто вже живе на v1» — навіть якщо споживача Pact не знаєш.
#   BASE_REV=origin/main bash scripts/ci/contract.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
BASE_REV="${BASE_REV:-origin/main}"
TMP=.tmp-contract
trap 'rm -rf "$TMP"' EXIT

if ! git cat-file -e "$BASE_REV:openapi/openapi.yaml" 2>/dev/null; then
  echo "у $BASE_REV немає openapi/openapi.yaml — бази для порівняння нема (перша поява спеки)"
  exit 0
fi
mkdir -p "$TMP"
git show "$BASE_REV:openapi/openapi.yaml" > "$TMP/base.yaml"
echo "порівнюю $BASE_REV:openapi/openapi.yaml -> openapi/openapi.yaml"
bash scripts/ci/oasdiff.sh "$TMP/base.yaml" openapi/openapi.yaml
echo "contract=ok"
