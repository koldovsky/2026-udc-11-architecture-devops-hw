# Task E (bonus) — Шлях 1: стек по-справжньому (Docker)

> Обрано один шлях (Шлях 1). Розділи шляхів 2 і 3 з шаблону прибрано, а не залишено порожніми.
> Дата: 2026-11-03. Docker: клієнт 29.6.2, сервер 29.5.3, Compose 5.3.1. Файли — `deploy/Dockerfile`
> і `deploy/compose.yaml` у тому вигляді, що в цьому PR (перша чернетка AI, `ai-runs/check-deploy-v1.txt`).

## Команди, якими підняли стек

Змінні задано в команді, закоміченого `.env` немає. Проєкт названо `ws11` (`-p ws11`), щоб контейнери
було легко відрізнити від чужих на тому самому Docker.

```bash
docker build -q -f deploy/Dockerfile -t poshtomat:ws11 app

IMAGE=poshtomat:ws11 SMS_TOKEN=CHANGE_ME \
  docker compose -p ws11 -f deploy/compose.yaml up -d --wait --wait-timeout 90

IMAGE=poshtomat:ws11 SMS_TOKEN=CHANGE_ME \
  docker compose -p ws11 -f deploy/compose.yaml ps
```

`docker compose … up -d --build` з walkthrough тут не підходить: у `deploy/compose.yaml` немає `build:`,
образ береться зі змінної `IMAGE` (так pipeline деплоїть образ за digest), тому образ збирається окремо.

## Вивід `docker compose ps`

```text
NAME            IMAGE            COMMAND                  SERVICE   CREATED          STATUS                    PORTS
ws11-api-1      poshtomat:ws11   "docker-entrypoint.s…"   api       16 seconds ago   Up 15 seconds (healthy)   0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp
ws11-worker-1   poshtomat:ws11   "docker-entrypoint.s…"   worker    16 seconds ago   Up 15 seconds             8080/tcp
```

`api` — `healthy`. `worker` — `Up` без перевірки: у `deploy/compose.yaml` для нього `healthcheck: disable: true`,
бо worker не слухає жодного порту, а `HEALTHCHECK` з образу ходить на HTTP `/health`, якого в worker немає
(`docker inspect` показує `"Test":["NONE"]`).

## `GET /health`

```text
$ curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:8080/health
{"status":"ok","version":"1.7.3"}
HTTP 200
```

Додатково перевірено в працюючих контейнерах:

| Що | Команда | Результат |
|---|---|---|
| Хто запущений | `docker exec ws11-api-1 id -un` (так само для worker) | `node` (не root) |
| Політика перезапуску | `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ws11-api-1` | `unless-stopped` |
| Пул з'єднань у запущеному api | `docker exec ws11-api-1 node -e 'import("./src/config.js").then(m=>console.log("dbPoolMax="+m.loadConfig().dbPoolMax))'` | `dbPoolMax=20` (тобто змінну з compose застосунок прочитав; саме це ловить правило `K1`) |
| Секрет не в образі | `docker history --no-trunc poshtomat:ws11 \| grep -c CHANGE_ME` | `0` |
| Worker стартував | `docker compose -p ws11 -f deploy/compose.yaml logs worker` | `{"level":"info","msg":"worker started","version":"1.7.3"}` |

## Що пішло не так і як полагодили

- **`up --build` не працює з цим compose.** Див. вище: `build:` у файлі немає, образ збирається окремою командою.
- **Змінні треба давати в кожній команді.** Перший виклик `docker compose -p ws11 … ps` без `IMAGE` і `SMS_TOKEN`
  дав `required variable IMAGE is missing a value: IMAGE is required`; те саме для `logs` (`SMS_TOKEN`).
  Це поведінка `${VAR:?…}` саме так, як задумано, а не збій стека: працюючі контейнери при цьому були здорові.
  Далі змінні експортовано в оболонці на час команд.
- **Порт 8080.** Перед підняттям перевірено, що він вільний (`lsof -nP -iTCP:8080 -sTCP:LISTEN`): раніше на цій машині його
  займав сторонній `ssh`-процес. Compose публікує порт на всіх інтерфейсах (`0.0.0.0:8080`), бо в `ports:` стоїть `"8080:8080"`
  без адреси; для продакшну на VM це потребує рішення про firewall або прив'язку до `127.0.0.1`, але в цьому PR я це не міняв.
- **Сховище.** `DATABASE_URL` у compose вказує на `192.0.2.10` (адреса з RFC 5737, недосяжна), але сервіси стартували, бо
  сховище в репо — у пам'яті (`app/src/db.js:1-2`); справжньої бази цей тест не перевіряє.

## Прибирання

```bash
IMAGE=poshtomat:ws11 SMS_TOKEN=CHANGE_ME docker compose -p ws11 -f deploy/compose.yaml down
docker rmi poshtomat:ws11
```
