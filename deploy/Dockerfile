# syntax=docker/dockerfile:1
#
# Образ «Поштомата громади»: один образ для api, worker і нічної задачі expire.
# Збирається з контекстом app/:  docker build -f deploy/Dockerfile app
#
# Базовий образ закріплено за версією і digest (перевірено в Docker Hub 2026-11-03):
# збірка відтворювана, а підміна тега не потрапить у продакшн. Оновлення — свідомо:
# нова версія + digest (docker buildx imagetools inspect node:<tag>) і прогін pipeline.
# Node 24 — LTS; CI ганяє тести на тій самій версії (pipeline/deploy.yml).
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

ENV NODE_ENV=production
WORKDIR /app

# Лише те, що потрібно в рантаймі: без тестів, документації, .git, .env.
# Залежностей немає (package.json без dependencies), тож npm ci не потрібен.
# Файли належать root, процес працює від node — код у контейнері не змінити.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# Секретів в образі немає: SMS_TOKEN і DATABASE_URL приходять під час запуску
# (deploy/compose.yaml, ${VAR:?…} з оточення).

USER node
EXPOSE 8080

# Перевірка для api: HTTP-сервер є лише в ньому. worker і expire з того самого образу
# вимикають її в compose (у них немає ports:). У slim-образі немає curl — через node.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec-форма: node отримує SIGTERM напряму (server.js і worker.js його обробляють).
CMD ["node", "src/server.js"]
