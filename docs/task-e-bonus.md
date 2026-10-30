# Task E (bonus) — обрано Шлях 1: стек по-справжньому (Docker)

Перевірено 2026-10-27 на macOS (x86_64): engine 29.9.2, Docker Compose 5.6.1. Вивід нижче — з
останнього прогону, на `deploy/compose.yaml` після рев'ю PR (секрети — посиланнями `${…:?…}`).
Перші прогони того ж дня йшли на engine 20.10.12 зі старою схемою секретів (`env_file`) — що там
пішло не так, див. останній розділ.

## Шлях 1 — стек по-справжньому (Docker)

- Команди, якими підняли стек (змінні — у команді, не в закоміченому `.env`):

  ```bash
  # У compose навмисно немає `build:` — на VM образ підтягується за digest (POSHTOMAT_IMAGE),
  # тож `up --build` з прикладу тут нічого не збирає; образ збираємо окремо.
  docker build -t poshtomat:local -f deploy/Dockerfile app

  # Окремої бази не потрібно: сховище в app/src/db.js — у пам'яті. Змінні — лише для цієї сесії.
  export POSHTOMAT_IMAGE=poshtomat:local DATABASE_URL=CHANGE_ME SMS_TOKEN=CHANGE_ME
  docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 90    # exit 0
  docker compose -f deploy/compose.yaml ps
  ```

- Вивід `docker compose -f deploy/compose.yaml ps` — `api` `healthy`; `worker` `Up`:

  ```text
  NAME              IMAGE             COMMAND                  SERVICE   CREATED         STATUS                   PORTS
  deploy-api-1      poshtomat:local   "docker-entrypoint.s…"   api       6 seconds ago   Up 5 seconds (healthy)   0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp
  deploy-worker-1   poshtomat:local   "docker-entrypoint.s…"   worker    6 seconds ago   Up 5 seconds             8080/tcp
  ```

  `worker` — `Up` без `(healthy)`, бо в compose для нього `healthcheck: disable: true`:
  worker не слухає порт, і `HEALTHCHECK` з образу (запит до `/health` на 8080) для нього
  завжди падав би, тож Docker вічно показував би `unhealthy`.

- Запит до `GET /health` і відповідь:

  ```text
  $ curl -si http://127.0.0.1:8080/health
  HTTP/1.1 200 OK
  content-type: application/json; charset=utf-8

  {"status":"ok","version":"1.7.3"}
  ```

  Логи старту:

  ```text
  api-1     | {"ts":"2026-10-27T12:16:36.264+02:00","level":"info","msg":"service started","version":"1.7.3"}
  worker-1  | {"ts":"2026-10-27T12:16:36.392+02:00","level":"info","msg":"worker started","version":"1.7.3"}
  ```

- Посилення з Task D працює під час виконання, а не лише в YAML:

  ```text
  $ docker compose -f deploy/compose.yaml exec -T api id
  uid=1000(node) gid=1000(node) groups=1000(node)          # USER node, не root
  $ docker compose -f deploy/compose.yaml exec -T api sh -c 'touch /app/x; touch /tmp/ok && echo tmp-writable'
  touch: cannot touch '/app/x': Read-only file system      # read_only: true
  tmp-writable                                             # tmpfs /tmp працює
  $ docker compose -f deploy/compose.yaml down              # 4 с — менше за stop_grace_period 20s,
                                                           # тобто SIGTERM оброблено, без SIGKILL
  $ env -u DATABASE_URL docker compose -f deploy/compose.yaml up -d
  error while interpolating x-env.DATABASE_URL: required variable DATABASE_URL is missing a value: DATABASE_URL must be set in .env
  ```

- Скрипт деплою з `pipeline/deploy.yml` (блок `REMOTE`) прогнано на тому самому Docker у теці, що
  відтворює `/opt/poshtomat`; підмінено лише `docker pull` (локального образу немає в реєстрі):

  | Деплой | Результат | `deploys.log` |
  |---|---|---|
  | 1. Поточний `deploy/compose.yaml` | `Deployed`, exit 0; `.env` з секретами — права 0600 | `deploy aaaaaaa` |
  | 2. Той самий compose, але `DB_POOL_SIZE` замість `DB_POOL_MAX`, як у v1.8.0 | `--wait` пройшов (`api` healthy), але перевірка пулу — `::error::api: DB_POOL_MAX не задано, код візьме дефолт 4` → відкат, exit 1. У виводі жодного значення секретів | `failed bbbbbbb`, `rollback aaaaaaa … failed bbbbbbb` |
  | 3. Знову деплой 1, без змін | `Deployed`; `.env.prev` не змінився (той самий md5) | `deploy aaaaaaa` |
  | 4. Compose, якого Compose на VM не розбирає | `config --quiet` зупинив деплой до будь-яких змін на диску | — |
  | 5. Після A і B — знову B, але проба пулу тимчасово падає (підмінено `curl`) | Відкату немає, працює далі B (`api` healthy), exit 1. До другого рев'ю PR тут був відкат на старіший A із записом `rollback aaaaaaa` | `failed bbbbbbb … unchanged` |
  | 6. Потім C з `DB_POOL_SIZE` | Відкат на B, тобто на попередній реліз, а не на A | `failed ccccccc`, `rollback bbbbbbb … failed ccccccc` |
  | 7. Після третього рев'ю PR (відкат теж проходить перевірку пулу): A, потім C з `DB_POOL_SIZE` | Відкат на A, перевірка пулу після відкату пройшла | `deploy aaaaaaa`, `failed ccccccc`, `rollback aaaaaaa … failed ccccccc` |
  | 8. Потім D з `DB_POOL_SIZE`, і проба пулу падає також після відкату (підмінено `curl`) | `::error::відкат піднявся, але перевірка пулу не пройшла`, exit 1. `rollback` у журнал не записано, тож за runbook це гілка «автовідкат не піднявся або не пройшов перевірку» | `failed ddddddd` |

  Чому в runbook для повтору без змін стоїть `--force-recreate`: у тій самій теці
  `docker compose up -d --wait api worker` вивів `Container poshtomat-api-1 Running` (контейнер не
  перестворено), а з `--force-recreate` — `Recreated`, потім `Healthy`.

  До рев'ю PR деплой 2 закінчувався б `Deployed`: `up --wait` з таким compose дає exit 0, а
  `/health` — 200 (`docker compose exec -T api printenv DB_POOL_MAX` → exit 1, `dbPoolMax=4`).

## Що пішло не так і як полагодили

1. **Compose 2.2.3 не прочитав `compose.yaml`:** `services.api.env_file.0 must be a string`.
   Тоді секрети йшли через довгу форму `env_file: [{path, required}]`, яку розуміє лише Compose
   ≥ 2.24, а Docker Desktop постачав 2.2.3. Полагодили оновленням Compose (офіційний бінарник
   v2.29.7 у `~/.docker/cli-plugins/`, sha256 звірено; згодом Docker Desktop оновився до 4.97 з
   Compose 5.6.1). Висновок для прод: Compose на VM може не розібрати новий файл, і дізнаємося
   ми про це вже після заміни файлів. Спершу додали перевірку версії ≥ 2.24. Після рев'ю PR
   `env_file` прибрали зовсім (секрети — `${…:?…}`, як у `AGENTS.md`), тож замість перевірки
   версії пайплайн тепер розбирає новий `compose.yaml` Compose-ом самої VM
   (`docker compose --env-file .env.new -f compose.yaml.new config --quiet`) до будь-яких змін.
   Це ловить будь-яку несумісність, а не лише одну (деплой 4 у таблиці).
2. **`up --build` з прикладу нічого не збирає:** у compose немає `build:`, тому образ зібрали
   окремо `docker build` і передали його тег через `POSHTOMAT_IMAGE` у команді.
3. **Секрети в обов'язковому файлі.** Зі старою схемою `secrets.env` мав існувати поруч із
   compose, а в `.gitignore` його не було; прогін ішов з копією в тимчасовій теці через
   `--project-directory`. Тепер секрети — звичайні змінні: локально в команді, на VM — у
   `.env` (0600), який `.gitignore` уже покриває. Рядок `secrets.env` з `.gitignore` прибрано.
4. **Після оновлення Docker Desktop `up` впав з `pull access denied for poshtomat`:** оновлення
   engine 20 → 29 очистило локальні образи, і compose пішов шукати `poshtomat:local` у Docker
   Hub. Образ перезібрали тією самою `docker build`.
