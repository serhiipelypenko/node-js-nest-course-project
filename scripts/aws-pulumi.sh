#!/usr/bin/env bash
# hw-31: pulumi up|destroy для стеку base або demo. Усі npm-скрипти (up:base, up:demo, destroy:*) — через
# with-secrets.sh → цей файл.
#   HW31_REAL_AWS=1 bash scripts/with-secrets.sh dev bash scripts/aws-pulumi.sh up base
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERB="${1:?up|destroy}"; STACK="${2:?base|demo}"
case "$VERB:$STACK" in up:base|up:demo|destroy:base|destroy:demo) ;; *) echo "✗ очікую up|destroy base|demo" >&2; exit 2 ;; esac

# shellcheck source=scripts/aws-env.sh
. "$ROOT/scripts/aws-env.sh"

# Бакет стану — єдине, що створюється поза Pulumi (курка й яйце: стан має де лежати ДО першого up).
# Не тегується Stack=demo, тож «tagged-resources-left» його не бачить; коштує копійки.
if ! aws s3api head-bucket --bucket "$HW31_STATE_BUCKET" 2>/dev/null; then
  [ "$VERB" = "up" ] || { echo "✗ бакета стану $HW31_STATE_BUCKET немає — нічого зносити" >&2; exit 1; }
  echo "→ створюю бакет стану $HW31_STATE_BUCKET"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$HW31_STATE_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$HW31_STATE_BUCKET" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$HW31_STATE_BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$HW31_STATE_BUCKET" --versioning-configuration Status=Enabled
fi

cd "$ROOT/infra/$STACK"
[ -d node_modules ] || npm ci --no-audit --no-fund
pulumi stack select "$STACK" --create >/dev/null

if [ "$VERB" = "up" ] && [ "$STACK" = "demo" ]; then
  # пароль демо-бази — з оточення (сховище), у git лише шифрований рядок
  : "${HW31_DB_PASSWORD:?HW31_DB_PASSWORD не задано (сховище → with-secrets.sh)}"
  pulumi config set --secret hw31:dbPassword "$HW31_DB_PASSWORD" --stack "$STACK"
fi

pulumi "$VERB" --yes --skip-preview --non-interactive --stack "$STACK"

if [ "$VERB" = "up" ] && [ "$STACK" = "base" ]; then
  cd "$ROOT"
  node scripts/aws-evidence-base.mjs
  node scripts/aws-evidence-iam.mjs
fi
if [ "$VERB" = "destroy" ] && [ "$STACK" = "base" ]; then
  # Після destroy base сам стек у бакеті порожній — прибираємо і його запис. Бакет лишається:
  # знести вручну, коли demo теж не потрібен (README ## AWS, «Прибирання»).
  (cd "$ROOT/infra/base" && pulumi stack rm base --yes --non-interactive)
  echo "→ base знесено. Бакет стану $HW31_STATE_BUCKET лишився (≈ $0): aws s3 rb s3://$HW31_STATE_BUCKET --force"
fi
