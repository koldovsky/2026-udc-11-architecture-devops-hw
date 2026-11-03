#!/usr/bin/env bash
# Деплой на VM. Запускає pipeline/deploy.yml (крок «Pull image and restart services»):
#   bash /opt/poshtomat/remote-deploy.sh <IMAGE> <IMAGE_TAG> <ref> <actor> <run-id>
# Аргументи вже звірено в workflow із суворими шаблонами; тут вони — лише дані.
# Поруч мають лежати: compose.yaml.new (новий реліз), .env (секрети, IMAGE/IMAGE_TAG поточного
# релізу), compose.yaml (поточний реліз, якщо вже був деплой).
#
# Порядок:
#   1. перевірити середовище (curl, compose з up --wait-timeout) і compose.yaml.new (config -q,
#      лише https:// для зовнішніх API, DB_POOL_MAX задано числом), стягнути образ — робочий
#      compose.yaml ще не чіпаємо;
#   2. зберегти робочий файл як compose.yaml.prev, підмінити, up --wait (api має стати healthy);
#   3. функціональна перевірка: розмір пулу в api і worker = DB_POOL_MAX, проба через пул api,
#      перший цикл worker без помилок;
#   4. лише після успіху атомарно записати IMAGE/IMAGE_TAG у .env і рядок у deploys.log.
# Будь-який збій на кроках 2–3 → повертаємо compose.yaml.prev і образ з .env, вихід ≠ 0.
set -euo pipefail
cd "$(dirname "$0")"

[ "$#" -eq 5 ] || { echo "usage: $0 IMAGE IMAGE_TAG REF ACTOR RUN_ID" >&2; exit 2; }
new_image=$1 new_tag=$2 ref=$3 actor=$4 run_id=$5

fail() { echo "deploy: $*" >&2; exit 1; }

command -v curl >/dev/null || fail 'на VM немає curl — він потрібен для проби після деплою'
docker compose up --help | grep -q -- --wait-timeout || fail 'docker compose не підтримує up --wait-timeout — оновіть Compose v2'

export IMAGE="$new_image" IMAGE_TAG="$new_tag"
docker compose -f compose.yaml.new config -q
# app/ схему URL не перевіряє, а SMS_TOKEN іде в заголовку Authorization (app/src/sms.js:33).
# Дозволено лише https:// (у будь-якому регістрі); http://, HTTP:// чи інша схема — стоп.
if docker compose -f compose.yaml.new config | grep '_BASE_URL: ' | grep -Eqiv '_BASE_URL: .?https://'; then
  fail 'SMS_BASE_URL і COURIER_BASE_URL на проді мають бути https://'
fi
# Скільки з'єднань пулу задає compose: з ним після старту звіряємо те, що взяв застосунок.
want_pool=$(docker compose -f compose.yaml.new config | sed -n 's/^ *DB_POOL_MAX: "\{0,1\}\([0-9][0-9]*\)"\{0,1\} *$/\1/p' | sort -u)
case "$want_pool" in
  '' | *[!0-9]*) fail "DB_POOL_MAX у compose.yaml.new не задано одним числом для всіх сервісів: '${want_pool//$'\n'/ }'" ;;
esac
want_pool=$((10#$want_pool))
docker compose -f compose.yaml.new pull --quiet api worker

# Функціональна перевірка нового релізу. HEALTHCHECK (/health) пулу не торкається, тож healthy
# ще не означає, що API обслуговує запити (docs/rca.md, доказ 15).
smoke() {
  local i code id svc got
  # Ефективний розмір пулу в процесі = DB_POOL_MAX з compose. Інакше застосунок не прочитав змінну
  # і взяв дефолт 4 (саме так було 14.10) — проби нижче цього б не помітили, бо одне з'єднання є.
  for svc in api worker; do
    got=$(docker compose exec -T "$svc" node --input-type=module \
      -e 'import { loadConfig } from "./src/config.js"; console.log(loadConfig().dbPoolMax)') || got='?'
    [ "$got" = "$want_pool" ] ||
      { echo "deploy: $svc — пул $got з'єднань, а DB_POOL_MAX у compose — $want_pool" >&2; return 1; }
  done
  # api: фальшивий токен → пошук сесії через пул з'єднань → 403 менш ніж за 3 с. 503 чи таймаут —
  # пул не видає з'єднань (як 14.10). Це проба пулу, а не PostgreSQL: у репо сховище в пам'яті.
  for i in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' \
      -H 'Authorization: Bearer deploy-probe' http://127.0.0.1:8080/admin/parcels) || true
    [ "$code" = 403 ] || { echo "deploy: проба пулу api — HTTP ${code:-000} замість 403" >&2; return 1; }
  done
  # worker: за 25 с проходить щонайменше один цикл опитування (раз на 10 с); він має працювати
  # без перезапусків, стартувати і не мати жодного «notify round failed» за час цього деплою.
  # Лог беремо не весь: якщо compose не перестворив worker (той самий образ і конфіг), у ньому
  # лишаються записи давніх запусків — давня помилка не має валити справний деплой, а давній
  # «worker started» — підтверджувати старт.
  sleep 25
  id=$(docker compose ps -q worker)
  [ -n "$id" ] || { echo 'deploy: контейнера worker немає' >&2; return 1; }
  local state started
  state=$(docker inspect -f '{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}' "$id")
  started=${state##* }
  [ "${state% *}" = "true 0" ] || { echo 'deploy: worker не працює або перезапускався' >&2; return 1; }
  docker compose logs --no-log-prefix --since "$started" worker | grep -q '"worker started"' ||
    { echo 'deploy: у лозі поточного запуску worker немає «worker started»' >&2; return 1; }
  if docker compose logs --no-log-prefix --since "$deploy_started" worker | grep -q 'notify round failed'; then
    echo 'deploy: worker пише «notify round failed»' >&2
    return 1
  fi
}

rollback() {
  echo "deploy: $1 — повертаю попередній compose.yaml і образ з .env" >&2
  if [ -f compose.yaml.prev ]; then mv compose.yaml.prev compose.yaml; fi
  unset IMAGE IMAGE_TAG
  docker compose up -d --remove-orphans --no-build || echo 'deploy: відкат не вдався — див. docs/runbook.md' >&2
  exit 1
}

if [ -f compose.yaml ]; then cp compose.yaml compose.yaml.prev; fi
mv compose.yaml.new compose.yaml
deploy_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d --remove-orphans --no-build --wait --wait-timeout 120 || rollback 'api не став healthy за 120 с'
smoke || rollback 'функціональна перевірка не пройшла'

# Новий IMAGE/IMAGE_TAG у .env — атомарно: повна копія (з тими самими правами — там секрети)
# правиться поруч і лише потім одним mv заміняє .env. Збій запису лишає старий .env цілим, і
# відкат на попередній образ з нього коректний.
write_env() {
  touch .env &&
    cp -p .env .env.tmp &&
    sed -i '/^IMAGE=/d; /^IMAGE_TAG=/d' .env.tmp &&
    printf 'IMAGE=%s\nIMAGE_TAG=%s\n' "$IMAGE" "$IMAGE_TAG" >> .env.tmp &&
    mv .env.tmp .env
}
write_env || { rm -f .env.tmp; rollback 'не вдалося записати .env'; }
# Журнал — для людей; збій запису в нього не скасовує вже перевірений і зафіксований у .env реліз.
printf '%s   deploy    %s   %s   image %s, run %s\n' "$(date -Iseconds)" "$ref" "$actor" "$IMAGE_TAG" "$run_id" >> deploys.log ||
  echo 'deploy: УВАГА — реліз працює, але рядок у deploys.log не записано' >&2
docker image prune -f || true
