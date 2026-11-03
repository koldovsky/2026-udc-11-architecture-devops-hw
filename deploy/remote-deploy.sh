#!/usr/bin/env bash
# Деплой на VM. Запускає pipeline/deploy.yml (крок «Pull image and restart services»):
#   bash /opt/poshtomat/remote-deploy.sh <IMAGE> <IMAGE_TAG> <ref> <actor> <run-id>
# Аргументи вже звірено в workflow із суворими шаблонами; тут вони — лише дані.
# Поруч мають лежати: compose.yaml.new (новий реліз), .env (секрети, IMAGE/IMAGE_TAG поточного
# релізу), compose.yaml (поточний реліз, якщо вже був деплой).
#
# Порядок:
#   1. перевірити середовище (curl, compose з up --wait-timeout) і compose.yaml.new (config -q,
#      стягнути образ; у api і worker — https:// для зовнішніх API і DB_POOL_MAX числом) — робочий
#      compose.yaml ще не чіпаємо;
#   2. зберегти робочий файл як compose.yaml.prev, підмінити, up --wait (api має стати healthy);
#   3. функціональна перевірка: розмір пулу в api і worker = DB_POOL_MAX, проба через пул api,
#      worker через 25 с запущений без нових перезапусків, вивів «worker started» і не записав
#      «notify round failed»;
#   4. лише після успіху атомарно записати IMAGE/IMAGE_TAG у .env і рядок у deploys.log.
# Будь-який збій на кроках 2–3 → повертаємо compose.yaml.prev і образ з .env, вихід ≠ 0; на першому
# деплої (compose.yaml.prev немає) — зупиняємо стек. Переривання вже після запису .env — реліз
# лишається (він пройшов перевірку), вихід ≠ 0.
set -euo pipefail
cd "$(dirname "$0")"

[ "$#" -eq 5 ] || { echo "usage: $0 IMAGE IMAGE_TAG REF ACTOR RUN_ID" >&2; exit 2; }
new_image=$1 new_tag=$2 ref=$3 actor=$4 run_id=$5

fail() { echo "deploy: $*" >&2; exit 1; }

command -v curl >/dev/null || fail 'на VM немає curl — він потрібен для проби після деплою'
docker compose up --help | grep -q -- --wait-timeout || fail 'docker compose не підтримує up --wait-timeout — оновіть Compose v2'

export IMAGE="$new_image" IMAGE_TAG="$new_tag"
docker compose -f compose.yaml.new config -q
docker compose -f compose.yaml.new pull --quiet api worker

# Змінні, які мусять бути в кожного з api і worker, — з розібраної конфігурації (config --format
# json), а не з рядків виводу: відсутня змінна в одному сервісі теж зупиняє деплой. Розбирає JSON
# node з образу релізу (на VM може не бути jq), без мережі.
#  - SMS_BASE_URL і COURIER_BASE_URL — розібрані як URL: схема https (будь-який регістр) і
#    непорожнє ім'я хоста (`https://` чи `https://:443` не проходять): app/ URL не перевіряє,
#    а SMS_TOKEN іде в заголовку Authorization (app/src/sms.js:33);
#  - DB_POOL_MAX — одне число для обох: з ним після старту звіряємо пул, який узяв застосунок.
want_pool=$(docker compose -f compose.yaml.new config --format json |
  docker run --rm -i --network none --entrypoint node "$IMAGE:$IMAGE_TAG" -e '
    const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const problems = [];
    const pools = new Set();
    for (const svc of ["api", "worker"]) {
      const env = cfg.services?.[svc]?.environment ?? {};
      for (const name of ["SMS_BASE_URL", "COURIER_BASE_URL"]) {
        const value = env[name];
        if (typeof value !== "string" || value === "") {
          problems.push(`${svc}: ${name} не задано`);
          continue;
        }
        let url = null;
        try {
          url = new URL(value);
        } catch {}
        if (!url) problems.push(`${svc}: ${name} — не URL`);
        else if (url.protocol !== "https:") problems.push(`${svc}: ${name} — не https://`);
        else if (!url.hostname) problems.push(`${svc}: ${name} — без імені хоста`);
      }
      const pool = String(env.DB_POOL_MAX ?? "");
      if (/^[0-9]+$/.test(pool)) pools.add(Number(pool));
      else problems.push(`${svc}: DB_POOL_MAX не задано числом`);
    }
    if (pools.size > 1) problems.push(`DB_POOL_MAX різний у сервісах: ${[...pools].join(", ")}`);
    if (problems.length) {
      console.error(problems.join("; "));
      process.exit(1);
    }
    console.log([...pools][0]);
  ') || fail 'змінні оточення в compose.yaml.new не пройшли перевірку (причина — рядком вище)'

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
  # worker: через 25 с після старту перевіряємо лише три речі — він запущений без нових
  # перезапусків, у лозі поточного запуску є «worker started», а за час цього деплою немає жодного
  # «notify round failed». Що цикл опитування справді пройшов, це не доводить: порожній цикл
  # (немає посилок) нічого в лог не пише.
  # Лог беремо не весь: якщо compose не перестворив worker (той самий образ і конфіг), у ньому
  # лишаються записи давніх запусків — давня помилка не має валити справний деплой, а давній
  # «worker started» — підтверджувати старт.
  sleep 25
  id=$(docker compose ps -q worker)
  [ -n "$id" ] || { echo 'deploy: контейнера worker немає' >&2; return 1; }
  local running restarts started allowed=0
  read -r running restarts started < <(docker inspect -f '{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}' "$id")
  # Той самий контейнер, що й до деплою (compose його не перестворив), — рахуємо лише перезапуски
  # після `up`; новий контейнер не мав перезапускатися взагалі.
  if [ "$id" = "$worker_before" ]; then allowed=$restarts_before; fi
  [ "$running" = true ] && [ "$restarts" = "$allowed" ] ||
    { echo "deploy: worker не працює або перезапускався під час деплою (перезапусків: $restarts, до деплою: $allowed)" >&2; return 1; }
  # Лог спершу в змінну, потім grep: у конвеєрі `logs | grep -q` grep виходить на першому збігу,
  # compose отримує SIGPIPE, і через pipefail увесь конвеєр — «невдача» навіть при збігу.
  local run_log deploy_log
  run_log=$(docker compose logs --no-log-prefix --since "$started" worker) ||
    { echo 'deploy: не вдалося прочитати лог worker' >&2; return 1; }
  deploy_log=$(docker compose logs --no-log-prefix --since "$deploy_started" worker) ||
    { echo 'deploy: не вдалося прочитати лог worker' >&2; return 1; }
  grep -q '"worker started"' <<<"$run_log" ||
    { echo 'deploy: у лозі поточного запуску worker немає «worker started»' >&2; return 1; }
  if grep -q 'notify round failed' <<<"$deploy_log"; then
    echo 'deploy: worker пише «notify round failed»' >&2
    return 1
  fi
}

# .env уже містить новий IMAGE/IMAGE_TAG (а не проміжний .env.tmp)?
env_has_new_release() {
  [ ! -e .env.tmp ] && grep -qxF "IMAGE=$new_image" .env 2>/dev/null && grep -qxF "IMAGE_TAG=$new_tag" .env 2>/dev/null
}

phase=verify # verify — до кінця smoke; commit — запис .env (smoke пройшов)
rollback() {
  trap - EXIT HUP INT TERM
  # Сигнал у фазі запису міг прийти вже після `mv .env.tmp .env`: тоді .env узгоджений з новим
  # compose.yaml, і повертати старий файл означало б старий compose з новим тегом. Стан фіксації
  # визначає сам .env, а не прапорець після mv (той міг не встигнути встановитися).
  if [ "$phase" = commit ] && env_has_new_release; then
    echo "deploy: $1 — але .env уже записано: реліз $new_tag лишається (перевірку він пройшов)" >&2
    printf '%s   deploy    %s   %s   image %s, run %s (перервано після запису .env)\n' \
      "$(date -Iseconds)" "$ref" "$actor" "$new_tag" "$run_id" >> deploys.log || true
    exit 1
  fi
  unset IMAGE IMAGE_TAG
  if [ -f compose.yaml.prev ]; then
    echo "deploy: $1 — повертаю попередній compose.yaml і образ з .env" >&2
    mv compose.yaml.prev compose.yaml
    docker compose up -d --remove-orphans --no-build || echo 'deploy: відкат не вдався — див. docs/runbook.md' >&2
  else
    # Перший деплой: попереднього релізу немає, повертати нічого. Зупиняємо стек, щоб зламаний
    # реліз не лишився запущеним; його compose зберігаємо як compose.yaml.failed для розбору.
    echo "deploy: $1 — це перший деплой, попереднього релізу немає: зупиняю стек" >&2
    IMAGE=$new_image IMAGE_TAG=$new_tag docker compose down --remove-orphans ||
      echo 'deploy: не вдалося зупинити стек — docker compose down вручну' >&2
    mv compose.yaml compose.yaml.failed
  fi
  exit 1
}

# compose.yaml.prev — лише від цього запуску: давня копія не має видавати перший деплой за повторний.
rm -f compose.yaml.prev
if [ -f compose.yaml ]; then cp compose.yaml compose.yaml.prev; fi
# Який worker працює зараз і скільки разів він уже перезапускався — щоб smoke рахував лише нові.
worker_before=$(docker compose ps -q worker 2>/dev/null || true)
restarts_before=0
if [ -n "$worker_before" ]; then
  restarts_before=$(docker inspect -f '{{.RestartCount}}' "$worker_before" 2>/dev/null || echo 0)
fi
# Від підміни compose.yaml до фіксації .env будь-який вихід, крім успішного, — це відкат: явна
# помилка, `set -e`, сигнал (HUP — розірвана ssh-сесія, INT, TERM) чи збій запису в закритий stdout.
# SIGKILL перехопити неможливо — тоді відкат вручну (docs/runbook.md, «Що робити», рядок 1).
trap 'rollback "деплой перервано (код $?)"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mv compose.yaml.new compose.yaml
deploy_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d --remove-orphans --no-build --wait --wait-timeout 120 || rollback 'api не став healthy за 120 с'
smoke || rollback 'функціональна перевірка не пройшла'
phase=commit

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
# Реліз зафіксовано (compose.yaml і .env узгоджені) — далі перерваний скрипт нічого не відкочує.
trap - EXIT HUP INT TERM
# Журнал — для людей; збій запису в нього не скасовує вже перевірений і зафіксований у .env реліз.
printf '%s   deploy    %s   %s   image %s, run %s\n' "$(date -Iseconds)" "$ref" "$actor" "$IMAGE_TAG" "$run_id" >> deploys.log ||
  echo 'deploy: УВАГА — реліз працює, але рядок у deploys.log не записано' >&2
docker image prune -f || true
