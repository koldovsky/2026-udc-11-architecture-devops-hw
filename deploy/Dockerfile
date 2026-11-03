FROM node:22-alpine

WORKDIR /app

# Явний COPY замість "COPY . ." — test/ і docs/ не потрапляють в образ.
COPY package.json ./
COPY src/          ./src/
COPY bin/          ./bin/

ENV NODE_ENV=production
# Усі секрети (DATABASE_URL, SMS_TOKEN, …) приходять зі змінних оточення контейнера
# під час запуску — в образ нічого чутливого не запікається.

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "src/server.js"]
