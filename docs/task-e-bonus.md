# Task E (bonus) — шлях 1: стек по-справжньому (Docker)

> Обрано шлях 1, бо він перевіряє конфіг деплою з Task D запуском, а не лише за формою.
> `npm run check:deploy` не бачить, чи існує digest базового образу, чи стартує
> контейнер у режимі тільки для читання і чи стає `api` справді `healthy`.
> Середовище: Windows 10, Docker Desktop 4.29.0: Engine 26.0.0 (Linux, x86_64), Compose v2.26.1.
> Пункт 3 нижче повторено після оновлення до Docker Desktop 4.96.3: Engine 29.9.2,
> Compose v5.6.1. Дата: 2026-10-26.

## Шлях 1 — стек по-справжньому (Docker)

- **Команди, якими підняли стек.** Змінні передано в команді, закоміченого `.env` немає.
  Команди запускаються з кореня репо в Git Bash.

  ```bash
  # 0. digest базового образу, який вказав AI, справді існує і відповідає тегу
  docker buildx imagetools inspect node:22.23.2-bookworm-slim | head -3
  #    Digest:    sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

  # 1. образ. У compose немає build:, бо образ має приходити з CI через POSHTOMAT_IMAGE,
  #    тож збираємо окремо
  docker build -t poshtomat:local -f deploy/Dockerfile app

  # 2. api і worker; усі три змінні compose вимагає через ${VAR:?}
  export POSHTOMAT_IMAGE=poshtomat:local \
         DATABASE_URL=postgres://poshtomat@localhost:5432/poshtomat \
         SMS_TOKEN=CHANGE_ME
  docker compose -f deploy/compose.yaml up -d                          # api + worker
  docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 90 api   # чекаємо healthy (див. пункт 3 нижче)
  docker compose -f deploy/compose.yaml ps
  ```

- **Вивід `docker compose -f deploy/compose.yaml ps`:**

  ```text
  NAME              IMAGE             COMMAND                  SERVICE   CREATED          STATUS                    PORTS
  deploy-api-1      poshtomat:local   "docker-entrypoint.s…"   api       33 seconds ago   Up 31 seconds (healthy)   0.0.0.0:8080->8080/tcp
  deploy-worker-1   poshtomat:local   "docker-entrypoint.s…"   worker    33 seconds ago   Up 31 seconds             8080/tcp
  ```

  `worker` має статус `Up` без `(healthy)`, бо перевірку для нього вимкнено
  (`healthcheck: disable: true` у `deploy/compose.yaml`). HTTP-сервера в нього немає,
  тож HTTP-перевірка з образу завжди падала б, а власного сигналу здоров'я worker не
  має: якщо процес упаде, його підніме `restart: unless-stopped`. Нічна задача
  `expire` не стартує, бо вона в `profiles: [jobs]` і запускається з cron через `run --rm expire`.

- **Запит до `GET /health` і відповідь:**

  ```text
  $ curl -s -w ' %{http_code}\n' http://localhost:8080/health
  {"status":"ok","version":"1.7.3"} 200
  ```

  Запис теж працює: `POST /parcels` повертає `{"id":1,"lockerId":12,"status":"waiting"} 201`.
  Сховище в репо зберігається в пам'яті, тож окрема база не потрібна.

- **Що перевірили в запущених контейнерах.** Посилення з Task D справді діє:

  ```text
  $ docker inspect --format '… user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} init={{.HostConfig.Init}} mem={{.HostConfig.Memory}} restart={{.HostConfig.RestartPolicy.Name}} …'
  deploy-api-1    user=node readonly=true init=true mem=536870912 restart=unless-stopped health=healthy
  deploy-worker-1 user=node readonly=true init=true mem=268435456 restart=unless-stopped health=none

  $ docker exec deploy-api-1 sh -c 'id; touch /app/x; env | grep -E "^DB_POOL|^TZ|^SMS_RATE"'
  uid=1000(node) gid=1000(node) groups=1000(node)
  touch: cannot touch '/app/x': Read-only file system
  DB_POOL_MAX=20
  DB_POOL_WAIT_MS=2000
  SMS_RATE_PER_SEC=20
  TZ=Europe/Kyiv
  ```

  Що з цього видно:
  - процес працює не під root;
  - файлова система тільки для читання;
  - ліміти пам'яті 512M і 256M;
  - контейнер бачить змінну `DB_POOL_MAX`, тобто назву, яку читає `config.js` (урок інциденту і правило `P1`);
  - час у логах київський: `"ts":"2026-10-26T09:28:40.458+02:00"`.

- **Що пішло не так і як полагодили:**
  1. **Команда з walkthrough `up -d --build` нічого не збирає.** У compose від AI немає `build:`:
     образ має приходити з реєстру CI через `POSHTOMAT_IMAGE`. Полагодили так: зібрали образ
     окремо через `docker build -t poshtomat:local …` і передали `POSHTOMAT_IMAGE=poshtomat:local`.
  2. **`SMS_TOKEN=CHANGE_ME docker compose … up` зупиняється:**
     `required variable DATABASE_URL is missing a value: DATABASE_URL не задано в .env`.
     Це не помилка, а очікувана поведінка `${VAR:?…}`: compose не стартує без секретів.
     Полагодили так: передали в команді всі три змінні.
  3. **Реальна вада: `up -d --wait` завершується з кодом 1, хоча все працює.**

     ```text
     $ POSHTOMAT_IMAGE=… docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 90
      Container deploy-api-1  Healthy
     container deploy-worker-1 has no healthcheck configured
     exit=1
     $ POSHTOMAT_IMAGE=… docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 90 api
      Container deploy-api-1  Healthy
     exit=0
     ```

     Compose v2.26.1 вважає помилкою, якщо `--wait` має чекати сервіс, перевірку якого вимкнено.
     **Чому це важливо.** Скрипт деплою в чернетці (`pipeline/deploy.yml` до виправлення:
     `up -d --wait` для всіх сервісів перед `echo "Розгорнуто"`) вважав ненульовий код
     ознакою, що «новий реліз не став healthy». Тож він відкочував би **кожен** деплой, а
     відкат тим самим `--wait` теж падав би. Тепер обидва місця — функція `up_and_wait` і
     блок відкату після `if up_and_wait` у тому ж файлі. Вада виникла на стику двох змін:
     `--wait` для всіх сервісів у чернетці AI і `disable: true` для worker, яке ми додали,
     щоб пройти D3. **Жодне правило `check:deploy` цього не бачить**, бо їх не можна
     перевірити по самих файлах. Знайшов це лише запуск.
     **Повтор на Compose v5.6.1** (Docker Desktop 4.96.3) — вада залежить від версії:

     ```text
     $ docker compose -f deploy/compose.yaml down && POSHTOMAT_IMAGE=… docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 90
      Container deploy-worker-1 Healthy
      Container deploy-api-1 Healthy
     exit=0
     ```

     Нова версія вважає сервіс з вимкненою перевіркою готовим, щойно він запущений.
     `ps` для worker так само показує `Up` без `(healthy)`. Тобто `pipeline/deploy.yml`
     працює чи ні **залежно від версії Compose на VM**, а її в даних немає.
     **Статус: виправлено** в `pipeline/deploy.yml`, функція `up_and_wait`. Вона робить
     `up -d --remove-orphans` для всіх сервісів, а потім `up -d --wait --wait-timeout 120 api`,
     тобто чекає лише на сервіс з перевіркою. Ця функція працює і для деплою, і для
     автоматичного відкату. Скрипт тепер не залежить від версії Compose. Після рев'ю
     CodeRabbit до неї додано `worker_stable`: за 20 с worker має бути `running` без жодного
     перезапуску. Інакше worker, що падає в циклі, пройшов би деплой непоміченим.
     Перевірено на Compose v5.6.1 (ця версія — з окремою `worker_stable` і вікном 20 с).
     Функції взято дослівно зі скрипта, а `.env` створено у тимчасовій теці поза репо:
     - справний worker — `up_and_wait` OK за 28 с;
     - worker, що падає через 3 с після старту (override `command`), — FAIL за 27 с з
       `worker нестабільний: running 5`. Сам `docker compose ps` у цей момент показував
       `Up 2 seconds`, тобто лише за статусом поломку не видно, її ловить `RestartCount`.

     Після `/code-review` перевірку worker перенесено всередину `up_and_wait`: лічильник
     перезапусків береться одразу після старту, а не після `--wait api`, і вікно — 60 с
     замість 20 (цикл «працює 25 с — падає» 20-секундне вікно пропускало). Між `--wait api`
     і перевіркою worker додано пробу БД (`db_probe`, той самий запит, що в runbook, очікує
     `403`), бо `/health` БД не перевіряє. Після наступного рев'ю CodeRabbit за те саме вікно
     перевіряється і лог worker: живий процес може не обробляти посилки, бо помилку раунду
     worker лише логує (`app/src/worker.js`, `main`). Рядок `notify round failed` у лозі за
     вікно означає FAIL.
     Перевірено на Docker Engine 29.9.2 / Compose v5.6.1, образ `poshtomat:local` з
     `deploy/Dockerfile`. Функції та віддалений скрипт узято дослівно з `pipeline/deploy.yml`
     (для повного скрипта прибрано лише `pull`: реєстру немає); поломки —
     заміною `command` у копії `compose.yaml` у тимчасовій теці поза репо:

     | Сценарій | Результат |
     |---|---|
     | справний реліз | `проба БД: 403`, OK за 66 с |
     | worker падає через 3 с | `worker нестабільний: restarting 9 (було 0)`, FAIL за 70 с |
     | worker падає через 25 с | `worker нестабільний: running 2 (було 0)`, FAIL за 62 с |
     | worker падає через 40 с | нова версія: `running 1 (було 0)`, FAIL за 73 с; **стара (вікно 20 с): OK за 33 с — пропустила** |
     | api: `/health` 200, решта 503 (як без БД) | `Healthy`, але `проба БД: 503`, FAIL за 8 с |
     | повний скрипт: новий реліз поганий, попередній справний | `відкат вдався…`, exit 1; `compose.yaml` — попередній, `compose.yaml.failed` — новий |
     | повний скрипт: поганий і новий, і попередній | `ВІДКАТ НЕ ВДАВСЯ…` + `ps` (worker `Restarting`), exit 1 |
     | worker живий, але кожен раунд падає (кожні 10 с пише `notify round failed`) | `worker не обробляє раунди: 6 × notify round failed` + 3 останні рядки, FAIL за 63 с (після рев'ю CodeRabbit: раніше `running 0 (було 0)` — OK); справний реліз з цією перевіркою — OK за 65 с |
     | `docker logs` завершується помилкою (підміна функції `docker` у тесті) | `не вдалося прочитати лог worker`, FAIL за 62 с (після рев'ю CodeRabbit: раніше `\|\| true` давав порожній результат, тобто OK) |
     | повний скрипт: перший деплой, реліз поганий | `попереднього релізу немає (перший деплой)…; зупиняю новий`, exit 1 за 12 с; api і worker — `Exited`, порт 8080 закритий (`curl` exit 7), `logs worker` доступні (після рев'ю CodeRabbit: раніше контейнери лишались працювати) |
     | повний скрипт: два невдалі перші деплої поспіль (раунди worker падають) | перший — exit 1 за 66 с, на VM лишаються тільки `compose.yaml.failed` і `.env.failed`, логи — через `-f compose.yaml.failed --env-file .env.failed logs worker`; другий — знову гілка «перший деплой», exit 1 за 65 с, відкату на поганий реліз немає (після рев'ю CodeRabbit: раніше активний `.env` першого релізу ставав `.prev`) |
     | повний скрипт: справний перший деплой, потім поганий (регресія) | `Розгорнуто` за 64 с; потім `відкат вдався…`, exit 1 за 134 с |

     Перевірено також:
     - послідовність дає exit 0 і на v2.26.1, і на v5.6.1;
     - віддалений скрипт проходить `bash -n`;
     - `npm run check:deploy` — PASS 14, FAIL 0, SKIP 0;
     - `npm run test:tools` — 28 з 28.

     Відкинутий варіант — вимагати на VM Compose новіший за v2.26.1. Тоді деплой залежав би
     від версії, яку ніхто не перевіряє, а точну версію, з якої поведінка змінилась, тут не
     встановлювали.

- **Як зупинити:** `POSHTOMAT_IMAGE=poshtomat:local DATABASE_URL=x SMS_TOKEN=x docker compose -f deploy/compose.yaml down`
