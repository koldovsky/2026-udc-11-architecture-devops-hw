# Task E (bonus) — оберіть ОДИН шлях

Обрано **шлях 1 — стек по-справжньому (Docker)**. Шляхи 2 і 3 не виконувались.

## Шлях 1 — стек по-справжньому (Docker)

Середовище: macOS, Docker Engine 28.0.1, Docker Compose v2.33.1 (Docker Desktop), 2026-11-09.
Конфігурація — `deploy/Dockerfile` і `deploy/compose.yaml` після Task D.

- Команди, якими підняли стек (змінні — у команді, не в закоміченому `.env`):

  ```bash
  # 1. Образ. У compose немає build: — у продакшні образ приходить з pipeline за digest
  #    через POSHTOMAT_IMAGE, тож локально збираємо його окремо.
  docker build -f deploy/Dockerfile -t poshtomat:local app

  # 2. Змінні, яких вимагає compose (${VAR:?…}). Сховище в репо — у пам'яті,
  #    тож DATABASE_URL лише має бути заданий; адреса — з RFC 5737, пароль — CHANGE_ME.
  export POSHTOMAT_IMAGE=poshtomat:local
  export DATABASE_URL=postgres://poshtomat:CHANGE_ME@192.0.2.10:5432/poshtomat
  export SMS_TOKEN=CHANGE_ME

  # 3. Старт: усі сервіси, потім чекаємо healthy від api і перевіряємо, що worker працює.
  docker compose -f deploy/compose.yaml up -d --remove-orphans
  docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 120 --no-recreate api
  test -n "$(docker compose -f deploy/compose.yaml ps -q --status running worker)" && echo "worker running"

  docker compose -f deploy/compose.yaml ps

  # Зупинити:
  docker compose -f deploy/compose.yaml down
  ```

- Вивід `docker compose -f deploy/compose.yaml ps`:

  ```text
  NAME                 IMAGE             COMMAND                  SERVICE   CREATED          STATUS                    PORTS
  poshtomat-api-1      poshtomat:local   "docker-entrypoint.s…"   api       25 seconds ago   Up 25 seconds (healthy)   0.0.0.0:8080->8080/tcp
  poshtomat-worker-1   poshtomat:local   "docker-entrypoint.s…"   worker    25 seconds ago   Up 25 seconds             8080/tcp
  ```

  `api` — `healthy`: `HEALTHCHECK` з образу робить `GET /health` через `node -e fetch(...)`.
  `worker` — `Up` без перевірки: у нього немає HTTP-сервера, тож HTTP-перевірка образу завжди
  показувала б `unhealthy`, а іншого сигналу здоров'я без змін в `app/` немає, тому в compose для
  нього `healthcheck: disable: true`. `8080/tcp` у worker — лише `EXPOSE` з образу, порт не
  опубліковано.

- Запит до `GET /health` і відповідь:

  ```text
  $ curl -i http://localhost:8080/health
  HTTP/1.1 200 OK
  {"status":"ok","version":"1.7.3"}
  ```

  Посилення з Task D справді діє: обидва контейнери працюють як `node:node` з read-only
  файловою системою (`docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}'` →
  `node:node true`). У логах `service started` і `worker started` без помилок.

- Що пішло не так і як полагодили:

  1. **`docker compose up -d --wait` завершується з кодом 1, хоча стек здоровий.** Compose
     v2.33 пише `container poshtomat-worker-1 has no healthcheck configured` і вважає це
     помилкою, бо для worker перевірку вимкнено. Саме цю команду використовував
     `pipeline/deploy.yml` (`docker compose up -d --wait … || rollback`), тож **кожен деплой
     відкочувався б**, навіть коли все працює, а `check:deploy` цього не бачить: правила
     статичні.
     **Як полагодили:** у `pipeline/deploy.yml` замість одного `up --wait` тепер функція
     `start_and_wait`: `up -d --remove-orphans` для всіх сервісів, потім
     `up -d --wait --no-recreate api` (чекає `healthy` лише від api), потім перевірка, що
     worker у стані `running`. Вона ж використовується для відкату. Коментар у шапці
     `deploy/compose.yaml` оновлено.
     **Перевірено обидва випадки:** здоровий стек → код 0; api з навмисно зламаним
     healthcheck (override-файл з `process.exit(1)`) → `container poshtomat-api-1 is unhealthy`,
     код 1, тобто відкат спрацював би.
  2. **`--build` з прикладу в завданні не підходить:** у compose немає `build:`, бо образ
     приходить за digest. Образ збираємо окремою командою `docker build` (крок 1).

  Після змін: `npm run check:deploy` — PASS 14, FAIL 0; `npm run test:tools` — 27 з 27.
