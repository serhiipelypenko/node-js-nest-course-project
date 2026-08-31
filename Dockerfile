# ---------- Stage 1: builder ----------
# Тут ставляться всі залежності (включно з dev) і компілюється Nest (nest build).
FROM node:22-slim AS builder

WORKDIR /app

# Кеш шарів: package*.json і конфіги копіюються окремо і РАНІШЕ решти коду.
# Поки вони не змінюються, шар з npm ci не перезбирається навіть якщо
# змінився src/.
COPY package*.json tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ---------- Stage 2: runner ----------
# Тільки production-залежності (express, express-openapi-validator, Nest core) +
# скомпільований dist. Ні TypeScript-компілятора, ні вихідних .ts-файлів тут
# немає.
FROM node:22-slim AS runner

# Свідомо НЕ ставимо жодного ENV: `docker inspect --format '{{.Config.Env}}'`
# має показувати лише змінні базового образу (PATH, NODE_VERSION, YARN_VERSION),
# жодних паролів чи прапорців. NODE_ENV передається ззовні (compose / -e).
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# express-openapi-validator валідує запити/відповіді проти цієї спеки в рантаймі,
# тож вона має бути доступна поруч із dist, а не лише на етапі збірки.
COPY openapi ./openapi
# .env.example — це контракт, він У образі. А от .env і secrets/ сюди НЕ
# потрапляють: їх вирізає .dockerignore.
COPY .env.example ./

# Non-root: офіційний node-образ вже містить користувача "node" (uid 1000).
USER node

CMD ["node", "dist/main.js"]
