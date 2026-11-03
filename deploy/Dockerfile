# Збірка з кореня репозиторію: docker build -f deploy/Dockerfile app
# Той самий образ запускає api, worker і нічну задачу, тому HEALTHCHECK тут немає:
# worker не слухає HTTP і був би вічно unhealthy. Перевірки api і worker — у compose.yaml.

# node:24-bookworm-slim, закріплено за дайджестом. Оновлюйте разом із node-version у workflow.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# За цією міткою деплой чистить старі образи, не зачіпаючи інші образи на VM.
LABEL org.opencontainers.image.title="poshtomat"

ENV NODE_ENV=production
WORKDIR /app

# Лише те, що потрібно під час роботи. package.json обов'язковий: у ньому "type": "module",
# і з нього src/version.js читає версію. npm install не потрібен: залежностей немає.
# Файли належать root, тож користувач node не може їх змінити.
COPY package.json ./
COPY src ./src
COPY bin ./bin

USER node

EXPOSE 8080

# Запуск напряму через node, а не через npm: процес має сам отримати SIGTERM.
CMD ["node", "src/server.js"]
