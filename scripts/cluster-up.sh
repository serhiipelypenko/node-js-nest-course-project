#!/usr/bin/env bash
# hw-28: піднімає kind-кластер (одна команда) і завантажує в нього образ.
# Образ, зібраний на хості, у кластері не існує: без `kind load` под зависне в ErrImagePull.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLUSTER="${CLUSTER:-hw28}"
IMAGE="${IMAGE:-marketplace-api:hw28}"

command -v kind >/dev/null || { echo "✗ kind не встановлено (brew install kind)" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "✗ немає образу $IMAGE — спершу npm run image:build" >&2; exit 1; }

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "кластер $CLUSTER уже піднятий"
else
  kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml
fi
kubectl --context "kind-$CLUSTER" wait --for=condition=Ready node --all --timeout=120s

# kind load docker-image ламається на Docker із containerd-сховищем образів
# («content digest … not found»); image-archive працює в обох випадках.
echo "→ вантажу $IMAGE у кластер"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
docker save "$IMAGE" -o "$TMP/image.tar"
kind load image-archive "$TMP/image.tar" --name "$CLUSTER"
kubectl --context "kind-$CLUSTER" get nodes
