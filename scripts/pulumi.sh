#!/usr/bin/env bash
# hw-28: обгортка над pulumi для теки infra/. Викликається ПІД scripts/with-secrets.sh,
# який кладе APP_DB_PASSWORD / PULUMI_CONFIG_PASSPHRASE в оточення.
#   bash scripts/with-secrets.sh dev bash scripts/pulumi.sh up
#
# Локальний файловий бекенд — щоб не впиратись у `pulumi login` до чужого акаунта.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/infra"

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true
# файловий бекенд не створює теку сам («unable to open state directory»)
case "$PULUMI_BACKEND_URL" in file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;; esac
STACK="${PULUMI_STACK:-dev}"

[ -d node_modules ] || { echo "✗ немає infra/node_modules — спершу npm --prefix infra ci" >&2; exit 1; }

if ! pulumi stack select "$STACK" >/dev/null 2>&1; then
  pulumi stack init "$STACK" >/dev/null
fi

case "${1:-}" in
  up)      shift; exec pulumi up --yes --non-interactive --skip-preview "$@" ;;
  destroy) shift; exec pulumi destroy --yes --non-interactive --skip-preview "$@" ;;
  *)       exec pulumi "$@" ;;
esac
