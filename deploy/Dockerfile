# syntax=docker/dockerfile:1
# Контекст збірки — ../app (див. deploy/compose.yaml та pipeline/deploy.yml).

# Пінована LTS-версія замість node:latest: збірка відтворювана, а alpine-варіант
# має мінімальну поверхню атаки. Залежностей немає, тож npm install не потрібен.
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# Копіюємо лише те, що потрібно в рантаймі — без тестів, доків і випадкових файлів
# (жодного COPY . .). Секрети (SMS_TOKEN тощо) в образ не запікаються —
# вони приходять лише через оточення під час запуску.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# Не root: вбудований непривілейований користувач з офіційного образу.
USER node

EXPOSE 8080

# Живість API через GET /health (curl в alpine немає — використовуємо node).
# Для сервісу worker цю перевірку вимкнено в compose.yaml: він не слухає HTTP.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
