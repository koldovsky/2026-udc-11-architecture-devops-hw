- Інструмент і модель: Claude Code 2.1.316 (headless `claude -p --model sonnet`), claude-sonnet-5-5
- Дата: 2026-11-02
- Що бачила сесія: тимчасова тека `../ws11-d/`: копії `app/`, `deploy/` і порожня `pipeline/` (без `tools/`). Нова сесія (окремий процес), без історії; інструменти `Read, Glob, Grep, Write, Edit` (без Bash), `--permission-mode acceptEdits`; файли агент записав у тимчасову теку, звідти вони скопійовані в репо (коміт «first AI draft»). Глобального `~/.claude/CLAUDE.md` немає; пам'ять Claude Code прив'язана до теки проєкту, для тимчасової теки вона порожня
- Вартість прогону: 12 ходів, 11 викликів інструментів (Glob × 1, Read × 6, Grep × 1, Write × 3), $0.167, 56 с
- Промпт (дослівно):

  > Підготуй деплой цього сервісу до продакшну: посиль deploy/Dockerfile і deploy/compose.yaml
  > і напиши pipeline/deploy.yml — workflow GitHub Actions: тести → збірка образу → деплой
  > із ручним погодженням через environment:, мінімальні permissions, секрети лише через
  > ${{ secrets.NAME }}.

---
Я підготував `deploy/Dockerfile`, `deploy/compose.yaml` і `pipeline/deploy.yml`. Нічого з цього я не запускав: ні `docker build`, ні `docker compose config`, ні сам workflow.

## `deploy/Dockerfile`
- Базовий образ тепер `node:22-alpine` замість `node:latest`. Це відповідає `engines >=22`. Для повної відтворюваності закріпіть його за digest, я залишив про це коментар.
- В образ копіюються лише `package.json`, `src` і `bin`. `package.json` потрібен, бо `version.js` читає його в рантаймі.
- Процес працює від користувача `node`, не від root.
- Рядок `ENV SMS_TOKEN=CHANGE_ME` прибрано, тож секретів в образі немає.
- Додано `HEALTHCHECK` на `/health`.

## `deploy/compose.yaml`
- **Секрети й образ:** `SMS_TOKEN` береться з `.env` на VM. Якщо його немає, compose не стартує. `image` — це `${IMAGE}`, тобто готовий образ з реєстру з конкретним тегом, а не `latest`.
- **Спільна конфігурація:** змінні оточення і параметри безпеки більше не дублюються між `api` і `worker`.
- **Обмеження контейнерів:** файлова система лише для читання (запис тільки в `/tmp`), `cap_drop: ALL`, `no-new-privileges`, ліміти пам'яті, CPU і кількості процесів, ротація логів.
- **Робота сервісів:** `init: true`, `restart: unless-stopped`, `stop_grace_period` 15 с.
- **Healthcheck:** у `worker` він вимкнений, бо інакше він успадкував би перевірку порту 8080, на якому worker нічого не слухає, і постійно був би unhealthy.
- **Порт:** `8080:8080` залишено відкритим, як було. Якщо перед сервісом стоїть reverse proxy, змініть на `127.0.0.1:8080:8080`.

## `pipeline/deploy.yml`
- **Порядок:** `test` → `build` → `deploy`.
- **Права:** на верхньому рівні `permissions: {}`. `test` отримує лише `contents: read`, `build` додатково `packages: write`, `deploy` додатково `packages: read`.
- **Збірка:** образ збирається з контексту `app` і `deploy/Dockerfile`, пушиться в GHCR з тегом `:<sha>`.
- **Ручне погодження:** воно настроюється в GitHub, не в файлі. Job `deploy` має `environment: production`, і щоб він чекав схвалення, в environment треба додати Required reviewers.
- **Секрети:** всі через `${{ secrets.NAME }}`. Їх повторне використання в `run` йде через `env:`, а не прямою підстановкою. Токен реєстру передається на VM через stdin.
- **Деплой по SSH:** `StrictHostKeyChecking=yes` з `DEPLOY_KNOWN_HOSTS`. `compose up -d --wait` перевіряє healthcheck, а ключі після деплою видаляються. `concurrency` не дає двом деплоям іти паралельно.

## Що зробити вам
1. Скопіюйте `pipeline/deploy.yml` у `.github/workflows/deploy.yml`, інакше GitHub його не запустить.
2. В environment `production` додайте Required reviewers і секрети `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
3. На VM створіть `/opt/poshtomat/.env` (chmod 600) з `SMS_TOKEN=...`.
4. Для `DATABASE_URL` пароль не задано: мабуть, доступ до PostgreSQL іде за адресою або через `pg_hba`. Якщо пароль знадобиться, додайте його в `.env` так само, як `SMS_TOKEN`.
5. Дії в workflow закріплені за мажорними тегами (`@v4` тощо). Для суворішого варіанту замініть їх на SHA комітів.
