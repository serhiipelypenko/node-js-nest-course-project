#!/usr/bin/env bash
# hw-28: збірка production-образу. Секрет етапу збірки — файл .npm_token у корені
# (у git його нема): docker build --secret id=npm_token,src=.npm_token.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${IMAGE:-marketplace-api:hw28}"
TOKEN_FILE="${NPM_TOKEN_FILE:-.npm_token}"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "✗ Немає $TOKEN_FILE — секрет етапу збірки (токен приватного реєстру)." >&2
  echo "  Локально/для грейдера: printf 'dummy-npm-token' > $TOKEN_FILE" >&2
  exit 1
fi

DOCKER_BUILDKIT=1 docker build \
  --secret "id=npm_token,src=$TOKEN_FILE" \
  -f docker/Dockerfile \
  -t "$IMAGE" \
  service
echo "✓ зібрано $IMAGE"
