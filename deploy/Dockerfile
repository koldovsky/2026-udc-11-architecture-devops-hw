# Без `# syntax=`: інструкціям цього файлу вистачає вбудованого фронтенду BuildKit, а
# незакріплений docker/dockerfile:1 тягнувся б під час збірки — і збірка не була б
# відтворюваною попри закріплений нижче digest.

# Один образ для api, worker і нічної задачі; яку саме програму запускати, задає
# deploy/compose.yaml. Контекст збірки — каталог app/:
#
#   docker build -f deploy/Dockerfile app
#
# Базовий образ закріплено за digest: тег — лише підказка для людей, Docker тягне
# саме digest, тож збірка відтворювана і підмінений тег її не зачепить. Оновлення —
# свідома правка цього рядка (PR від Dependabot, pipeline/dependabot.yml). Мажорна версія
# Node тут і NODE_VERSION у pipeline/deploy.yml (на ній ганяються тести) мають збігатися.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=production
WORKDIR /app

# Лише те, що потрібно в рантаймі (без тестів і документації). Залежностей у
# package.json немає, тож npm install не потрібен. Файли належать root і доступні
# користувачу node лише на читання: процес не може переписати власний код.
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Непривілейований користувач із базового образу (uid 1000).
USER node

EXPOSE 8080

# Перевірка здоров'я процесу за замовчуванням — API (CMD нижче): HTTP /health через
# вбудований у Node fetch (у slim-образі немає curl/wget). Вона живе в образі, а не в
# compose, щоб образ ніде не запускався без неї: і в smoke-тесті pipeline, і на VM, де за
# нею `docker compose up --wait` вирішує, чи відкочувати реліз. Worker і нічна задача з
# цього ж образу HTTP не слухають — compose.yaml вимикає для них цю перевірку явно.
# Це перевірка «процес живий і відповідає», а не готовності БД: /health не бере з'єднання з
# пулу і навмисно лишається 200 під піковим навантаженням (docs/postmortem.md, #5), щоб пік
# не робив контейнер unhealthy, а реліз, викладений у пік, не відкочувався. Вичерпаний пул
# v1.8.0 перевірка через пул і не зловила б: `up --wait` завершується на першому «healthy»,
# ще до навантаження. Такий реліз зупиняє C5 у `npm run check:deploy`, лише якщо назва змінної
# не збігається з тим, що читає app/src/config.js (post-mortem #3). Алерт ApiDbPoolWaiting
# (post-mortem #4) лише сповіщає чергового після викладення і релізу не зупиняє. Перевірка
# готовності через пул — новий ендпоінт в app/.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node запускається напряму (не через npm start), тож SIGTERM доходить до процесу і той
# завершується коректно.
CMD ["node", "src/server.js"]
