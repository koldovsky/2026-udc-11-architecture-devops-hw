#!/usr/bin/env bash
# Деплой на VM. Запускає pipeline/deploy.yml (крок «Pull image and restart services»):
#   bash /opt/poshtomat/remote-deploy.sh <IMAGE> <IMAGE_TAG> <ref> <actor> <run-id>
# Аргументи вже звірено в workflow із суворими шаблонами; тут вони — лише дані.
# Поруч мають лежати: compose.yaml.new (новий реліз), .env (секрети, IMAGE/IMAGE_TAG поточного
# релізу), compose.yaml (поточний реліз, якщо вже був деплой).
#
# Порядок:
#   1. перевірити середовище (curl, compose з up --wait-timeout) і compose.yaml.new (config -q,
#      лише https:// для зовнішніх API), стягнути образ — робочий compose.yaml ще не чіпаємо;
#   2. зберегти робочий файл як compose.yaml.prev, підмінити, up --wait (api має стати healthy);
#   3. функціональна перевірка: проба через пул з'єднань api і перший цикл worker без помилок;
#   4. лише після успіху записати IMAGE/IMAGE_TAG у .env і рядок у deploys.log.
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
# app/ схему URL не перевіряє, а SMS_TOKEN іде в заголовку Authorization (app/src/sms.js:33)
if docker compose -f compose.yaml.new config | grep -Eq '_BASE_URL: .?http://'; then
  fail 'SMS_BASE_URL і COURIER_BASE_URL на проді мають бути https://'
fi
docker compose -f compose.yaml.new pull --quiet api worker

# Функціональна перевірка нового релізу. HEALTHCHECK (/health) пулу не торкається, тож healthy
# ще не означає, що API обслуговує запити (docs/rca.md, доказ 15).
smoke() {
  local i code id
  # api: фальшивий токен → пошук сесії через пул з'єднань → 403 менш ніж за 3 с. 503 чи таймаут —
  # пул не видає з'єднань (як 14.10). Це проба пулу, а не PostgreSQL: у репо сховище в пам'яті.
  for i in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' \
      -H 'Authorization: Bearer deploy-probe' http://127.0.0.1:8080/admin/parcels) || true
    [ "$code" = 403 ] || { echo "deploy: проба пулу api — HTTP ${code:-000} замість 403" >&2; return 1; }
  done
  # worker: за 25 с проходить щонайменше один цикл опитування (раз на 10 с); він має працювати
  # без перезапусків, стартувати і не мати жодного «notify round failed».
  sleep 25
  id=$(docker compose ps -q worker)
  [ -n "$id" ] || { echo 'deploy: контейнера worker немає' >&2; return 1; }
  [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$id")" = "true 0" ] ||
    { echo 'deploy: worker не працює або перезапускався' >&2; return 1; }
  docker compose logs --no-log-prefix worker | grep -q '"worker started"' ||
    { echo 'deploy: у лозі worker немає «worker started»' >&2; return 1; }
  if docker compose logs --no-log-prefix worker | grep -q 'notify round failed'; then
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
docker compose up -d --remove-orphans --no-build --wait --wait-timeout 120 || rollback 'api не став healthy за 120 с'
smoke || rollback 'функціональна перевірка не пройшла'

touch .env
sed -i '/^IMAGE=/d; /^IMAGE_TAG=/d' .env
printf 'IMAGE=%s\nIMAGE_TAG=%s\n' "$IMAGE" "$IMAGE_TAG" >> .env
printf '%s   deploy    %s   %s   image %s, run %s\n' "$(date -Iseconds)" "$ref" "$actor" "$IMAGE_TAG" "$run_id" >> deploys.log
docker image prune -f
