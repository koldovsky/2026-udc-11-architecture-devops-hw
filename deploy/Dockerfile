# syntax=docker/dockerfile:1
# Образ для api, worker і нічної задачі (один образ, різні command у compose.yaml).
# Збірка: docker build -f deploy/Dockerfile app   (контекст — каталог app/)

# Node 22 LTS (package.json: engines >=22), slim-варіант на Debian — у ньому є tzdata
# для TZ=Europe/Kyiv. Закріплено за digest: тег можна перезаписати, digest — ні.
# Оновлення: новий тег + його digest з `docker buildx imagetools inspect node:<тег>`.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

FROM ${NODE_IMAGE}

ENV NODE_ENV=production

WORKDIR /app

# Лише те, що потрібно в рантаймі: без тестів, документації та будь-яких локальних
# файлів (.env тощо). Залежностей немає, тож npm install не потрібен.
# Файли належать root, і процес (користувач node) не може їх змінити.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# Непривілейований користувач з базового образу (uid 1000).
USER node

EXPOSE 8080

# Перевірка здоров'я HTTP-сервера (api — типова команда образу). У slim-образі немає curl,
# тому через node. Worker і нічна задача HTTP не слухають — compose її для них вимикає.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Секретів тут немає й не має бути: SMS_TOKEN, DATABASE_URL тощо задаються під час
# запуску (deploy/compose.yaml).
CMD ["node", "src/server.js"]
