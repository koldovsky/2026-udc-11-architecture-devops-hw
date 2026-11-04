# syntax=docker/dockerfile:1
# Образ «Поштомата громади»: api, worker і нічна задача — з одного образу.
# Збирається з контексту ../app:  docker build -f deploy/Dockerfile app
#
# Мажорна версія Node зафіксована (package.json: engines >=22). Для повної
# відтворюваності закріпіть ще й digest:  FROM node:22-bookworm-slim@sha256:<digest>
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Europe/Kyiv

WORKDIR /app

# Залежностей немає (npm install не потрібен). Копіюємо лише те, що потрібно
# в рантаймі: без тестів, документації та будь-яких локальних файлів (.env тощо).
# Файли належать root і доступні лише на читання — процес не може їх змінити.
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Користувач node (uid 1000) є в базовому образі.
USER node

EXPOSE 8080

# Без curl/wget в образі: перевіряємо /health засобами самого Node.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# SIGTERM обробляється в server.js / worker.js; init (tini) додає compose (init: true).
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
