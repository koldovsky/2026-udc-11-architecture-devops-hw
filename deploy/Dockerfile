# Збірка: build context = ../app (див. compose.yaml / pipeline/deploy.yml).
# Залежностей немає, тому окремої build-стадії не потрібно.
# Для відтворюваності закріпіть базовий образ за digest: node:22-alpine@sha256:<digest>
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Лише те, що потрібно в рантаймі (package.json читає src/version.js).
# Власник — непривілейований користувач node, що вже є в образі.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin

# SMS_TOKEN та інші секрети в образ не вшиваються — лише змінні оточення в рантаймі.
USER node

EXPOSE 8080

# Для сервісу worker (не слухає порт) healthcheck вимикається в compose.yaml.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
