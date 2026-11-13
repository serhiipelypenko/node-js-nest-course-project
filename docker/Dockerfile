# hw-28: production-образ. Збірка: npm run image:build
#   (docker build --secret id=npm_token,src=.npm_token -f docker/Dockerfile service)
#
# Дві стадії: збірка (Debian, npm, TypeScript) і запуск (distroless, без shell).
# Мета distroless — не розмір, а те, чого бракує зловмиснику після RCE: sh немає.

# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./

# Секрет етапу збірки (токен приватного реєстру) — ТІЛЬКИ через --mount=type=secret.
# Він змонтований у /run/secrets/npm_token лише на час цього RUN. ARG осів би в
# метаданих образу (docker history), COPY + rm — у байтах шару. Тут нема ні того, ні
# іншого: .npmrc створюється й видаляється в МЕЖАХ одного RUN, а сам токен в образ не
# потрапляє. Для справжнього приватного реєстру замініть хост і додайте
# `@scope:registry=…` — тут реєстр публічний, токен-приманка перевіряється демо.
RUN --mount=type=secret,id=npm_token \
    set -eu; \
    TOKEN="$(cat /run/secrets/npm_token)"; \
    test -n "$TOKEN"; \
    printf '//registry.private.invalid/:_authToken=%s\n' "$TOKEN" > "$HOME/.npmrc"; \
    npm ci; \
    rm -f "$HOME/.npmrc"

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app/dist ./dist
# 🔴 Числом, не іменем: kubelet з runAsNonRoot не резолвить `nonroot`
# («image has non-numeric user (nonroot), cannot verify user is non-root»).
USER 65532:65532
EXPOSE 8080
# ENTRYPOINT образу вже ["/nodejs/bin/node"], тому CMD — лише аргументи.
CMD ["dist/main.js"]
