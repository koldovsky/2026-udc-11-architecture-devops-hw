# Task E (bonus) — оберіть ОДИН шлях

> Скопіюйте у `docs/task-e-bonus.md` і заповніть лише обраний розділ.
> Приклади курсивом — з **іншої** системи (онлайн-запис до клініки).

## Шлях 1 — стек по-справжньому (Docker) — ✅ обраний шлях

Перевірено 2026-11-02, Docker Desktop на Windows 11 (PowerShell), з кореня репо; `ps` і `/health`
повторно знято 2026-11-03 після того, як порт API повернули на `8080:8080` (логи — з 2026-11-02).

- Команди, якими підняли стек (змінні задано через `$env:` у тій самій сесії PowerShell
  прямо перед `docker compose`, а не в `.env`; усі секрети — заглушки `CHANGE_ME`; список
  обов'язкових змінних — у шапці `deploy/compose.yaml:5-10`):

  ```powershell
  $env:IMAGE_TAG='local'; $env:DATABASE_URL='CHANGE_ME'; $env:SMS_TOKEN='CHANGE_ME'; `
  $env:SMS_BASE_URL='http://localhost:9001'; $env:COURIER_BASE_URL='http://localhost:9002'; `
  docker compose -f deploy/compose.yaml up -d --build
  docker compose -f deploy/compose.yaml ps
  curl.exe -s -i http://localhost:8080/health
  docker compose -f deploy/compose.yaml logs --no-log-prefix api worker
  docker compose -f deploy/compose.yaml down
  ```

  Еквівалент для bash (як у шапці compose, `deploy/compose.yaml:16-18`):

  ```bash
  IMAGE_TAG=local DATABASE_URL=CHANGE_ME SMS_TOKEN=CHANGE_ME \
  SMS_BASE_URL=http://localhost:9001 COURIER_BASE_URL=http://localhost:9002 \
  docker compose -f deploy/compose.yaml up -d --build
  ```

- Вивід `docker compose -f deploy/compose.yaml ps` (~40 с після старту) — `api` `healthy`;
  `worker` — `Up`, бо перевірку для нього вимкнено:

  ```text
  NAME              IMAGE             COMMAND                  SERVICE   CREATED          STATUS                    PORTS
  deploy-api-1      poshtomat:local   "docker-entrypoint.s…"   api       41 seconds ago   Up 40 seconds (healthy)   0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp
  deploy-worker-1   poshtomat:local   "docker-entrypoint.s…"   worker    41 seconds ago   Up 40 seconds             8080/tcp
  ```

  Чому `worker` без healthcheck: `worker.js` не піднімає HTTP-сервера (`app/src/worker.js:40-58` —
  лише цикл опитування; `http.createServer`/`listen` є тільки в `app/src/server.js:93-95`), тож
  успадкований з образу `HEALTHCHECK` на `:8080/health` (`deploy/Dockerfile:18-19`) завжди падав би
  і позначав його `unhealthy` — тому в `deploy/compose.yaml:74-77` стоїть `healthcheck: disable: true`.
  Для `api` окремого `healthcheck:` у compose немає — діє той самий `HEALTHCHECK` з образу
  (`docker inspect deploy-api-1 --format '{{json .Config.Healthcheck}}'` → `wget -qO- http://localhost:8080/health`,
  30s / 5s / 15s / 3); у worker `docker inspect` показує `"Test":["NONE"]`.
  `8080/tcp` у колонці PORTS для worker — це лише `EXPOSE` з образу, порт на хост не опубліковано.

- Запит до `GET /health` і відповідь:

  ```text
  > curl.exe -s -i http://localhost:8080/health
  HTTP/1.1 200 OK
  content-type: application/json; charset=utf-8
  Date: Tue, 03 Nov 2026 08:22:30 GMT
  Connection: keep-alive
  Keep-Alive: timeout=5
  Transfer-Encoding: chunked

  {"status":"ok","version":"1.7.3"}
  ```

  Логи (`docker compose ... logs --no-log-prefix api worker`):

  ```text
  {"ts":"2026-11-02T17:03:26.533+02:00","level":"info","msg":"service started","version":"1.7.3"}
  {"ts":"2026-11-02T17:03:26.581+02:00","level":"info","msg":"worker started","version":"1.7.3"}
  ```

  Помилок SMS у логах worker немає, і це не означає, що SMS «працюють»: сховище в репо — у пам'яті
  і стартує порожнім (`app/src/db.js:11-12`), тож `listUnnotified` (`app/src/db.js:40-44`) нічого не
  повертає і worker жодного разу не звертається до SMS-шлюзу. Якби посилки були, виклики на
  `SMS_BASE_URL=http://localhost:9001` (заглушка; усередині контейнера `localhost` — сам контейнер)
  завершувалися б `sms send failed` (`app/src/worker.js:30`). `DATABASE_URL=CHANGE_ME` теж ні на що
  не впливає — пул у репо не підключається до PostgreSQL.

- Що пішло не так і як полагодили: стек піднявся з першої спроби, правок у `deploy/` не знадобилося.
  Нюанси: (1) `docker` доступний лише з PowerShell, тому змінні задано через `$env:` в тій самій
  команді, а `.env` не створювали; (2) без будь-якої з обов'язкових змінних compose падає ще до
  старту через `${VAR:?…}` (`deploy/compose.yaml:28-31,36`) — це очікувано; (3) після перевірки
  стек зупинено `docker compose -f deploy/compose.yaml down` (образ `poshtomat:local` лишився).

## Шлях 2 — STRIDE для архітектури з вашого ADR — не обрано

## Шлях 3 — оцінка вартості — не обрано
