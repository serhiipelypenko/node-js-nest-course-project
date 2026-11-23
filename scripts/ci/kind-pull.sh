#!/usr/bin/env bash
# hw-32: кладе образ ЗА DIGEST у containerd вузла kind. Образ, якого в кластері нема, = ErrImagePull
# (imagePullPolicy: IfNotPresent не рятує). Тягнемо рівно ref@sha256:…, а не тег: ім'я в сховищі вузла
# збігається з тим, що стоїть у маніфесті Deployment, а digest — той самий, що віддала збірка.
#   GHCR_USER=… GHCR_TOKEN=… bash scripts/ci/kind-pull.sh ghcr.io/<owner>/<repo>/marketplace-api@sha256:…
# crictl без --no-trunc ріже digest до 13 знаків — grep повного sha256 тоді не збігається.
# Креденшел іде в `docker exec` через ЗМІННУ ОТОЧЕННЯ (не аргументом) і ніде не друкується.
set -euo pipefail
REF="${1:?використання: kind-pull.sh <image@sha256:…>}"
case "$REF" in *@sha256:*) ;; *) echo "✗ образ без digest: $REF" >&2; exit 1 ;; esac
: "${GHCR_USER:?}" "${GHCR_TOKEN:?}"
NODE="${KIND_NODE:-hw28-control-plane}"
DIGEST="${REF##*@}"

docker exec -e GHCR_USER -e GHCR_TOKEN "$NODE" \
  sh -c 'ctr --namespace k8s.io images pull --user "$GHCR_USER:$GHCR_TOKEN" "$1" >/dev/null' sh "$REF"

if docker exec "$NODE" crictl images --digests --no-trunc | grep -qF "$DIGEST"; then
  echo "образ у вузлі kind: $DIGEST"
else
  echo "✗ $DIGEST не з'явився в сховищі вузла $NODE" >&2
  exit 1
fi
