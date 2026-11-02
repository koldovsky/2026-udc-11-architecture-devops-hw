# syntax=docker/dockerfile:1
#
# Один образ на три точки входу (api, worker, нічна задача) — команду обирає
# compose. Збирається з контекстом `app/`:
#   docker build -f deploy/Dockerfile app
#
# Базовий образ закріплений тегом. Тег у node:22-alpine рухається з патчами, тому
# для повторюваної збірки його можна закріпити digest-ом на виклику — пайплайн
# цього поки не робить, і це свідомий компроміс, а не недогляд:
#   docker build --build-arg NODE_IMAGE=node:22-alpine@sha256:<digest> -f deploy/Dockerfile app
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="poshtomat" \
      org.opencontainers.image.description="Community parcel lockers: HTTP API, SMS worker and a nightly expiry job"

# Тільки не-секретні налаштування. DATABASE_URL і SMS_TOKEN приходять у
# рантаймі (див. deploy/compose.yaml) — секрет у ENV назавжди залишився б у
# шарі образу й у `docker history`.
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Залежностей у сервісі немає, тому немає ні `npm install`, ні lockfile.
# package.json потрібен у рантаймі: src/version.js читає з нього VERSION для
# GET /health. Файли належать root, а процес — ні, тож код сам себе не перепише.
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Користувач `node` (uid 1000) є в базовому образі.
USER node

EXPOSE 8080

# Перевірка через власний GET /health сервісу: ні curl, ні wget в образ не
# потрібні. Успадковується і воркером, але там порту немає, тому compose її
# для воркера не застосовує.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Exec-форма: node стає PID 1 і отримує SIGTERM напряму — саме на нього
# розраховують обробники в src/server.js і src/worker.js.
CMD ["node", "src/server.js"]
