#!/usr/bin/env bash
# hw-31: спільне оточення для scripts/aws-*.sh (source, не exec). Викликається ПІД with-secrets.sh,
# який кладе AWS-креденшели (AWS_PROFILE / AWS_ACCESS_KEY_ID…), HW31_BUDGET_EMAIL, HW31_DB_PASSWORD.
#
# 🔴 Ворота грошей: без HW31_REAL_AWS=1 нічого не створюється в справжньому AWS.
# 🔴 `pulumi login` і `aws configure` ніде не викликаємо — вони переписують глобальний стан машини.
#     Бекенд і регіон — лише змінними оточення цього процесу.
if [ "${HW31_REAL_AWS:-0}" != "1" ]; then
  echo "SKIPPED: це створює справжні платні ресурси в AWS. Увімкнути: HW31_REAL_AWS=1 npm run <скрипт>" >&2
  exit 0
fi

export AWS_REGION="${AWS_REGION:-eu-central-1}"      # той самий, що aws:region у Pulumi.<stack>.yaml
export AWS_DEFAULT_REGION="$AWS_REGION"
export PULUMI_SKIP_UPDATE_CHECK=true

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export HW31_STATE_BUCKET="${HW31_STATE_BUCKET:-hw31-pulumi-state-$ACCOUNT_ID}"
# Бекенд стану — S3 у власному акаунті: file:// з hw-28 воркер GitHub не бачить.
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-s3://$HW31_STATE_BUCKET?region=$AWS_REGION}"
# Порожня парольна фраза (змінна ЗАДАНА, але порожня): CI-роль без жодного секрету розшифровує стан.
# Єдиний секрет у стані — одноразовий пароль демо-бази в приватній підмережі.
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE-}"
