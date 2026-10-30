# Образ для api, worker і нічної задачі expire. Збирається з контекстом ../app:
#   docker build -f deploy/Dockerfile app
#
# Зафіксовано мажорну версію Node 22 (package.json: engines.node >=22). Для повної
# відтворюваності закріпіть точну версію і digest: FROM node:22.<x>-bookworm-slim@sha256:<digest>
FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Залежностей немає (npm install не потрібен), тож копіюємо лише те, що запускається:
# без тестів, документації та будь-яких випадкових файлів із робочої копії.
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root bin ./bin

# Код належить root і доступний лише на читання; процес працює як непривілейований node.
USER node

EXPOSE 8080

# Для api. Worker і expire не слухають порт — у compose для них healthcheck вимкнено.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/server.js"]
