# Runbook: API повільний або віддає 5xx (`ApiLatencyP95High`, `Api5xxRateHigh`)

_Власник: керівник on-call ротації. Складено 2026-10-25 за `docs/rca.md` (інцидент 2026-10-14).
Ці команди ще ніхто не запускав на проді. Хто перший виконає їх під час чергування,
допишіть сюди дату і що довелося виправити. Блоки «Приклад на даних інциденту» — вивід тієї
самої команди на файлах з `incident/`, запущеної з кореня репо.
Деталі інфраструктури (шляхи, контакти, дашборд) синтетичні, як і все в цьому навчальному репо.
Як влаштований прод і деплой — у «Довідці» в кінці._

- **Алерт(и):** обидва мають severity `page` і йдуть у `#poshtomat-oncall` + дзвінок черговому (`incident/alerts.json`):
  - `ApiLatencyP95High`: `p95_ms > 2000` протягом 3 хв;
  - `Api5xxRateHigh`: `error_rate > 0.05` (понад 5 % відповідей 5xx) протягом 3 хв.

  Зазвичай вони приходять парою з різницею в хвилину. Окремий алерт `SmsProvider429RateHigh`
  (warning) стосується worker-а, а не API (див. «Відомі хибні сліди», Д9).
- **Що це означає для користувачів:** поштомат після введення коду показує «Сервіс зайнятий,
  спробуйте пізніше» і посилку не видає. 14.10 близько 77 % усіх 503 припали на
  `POST /pickup`, тобто на видачу посилок. Решта припала на реєстрацію посилок кур'єром
  (`POST /parcels`) і на адмінку (`GET /admin/parcels`). Те, що термінал перекладає 503 у
  «Сервіс зайнятий», — **припущення**: коду термінала в репо немає.
- **Скільки є часу:** вплив починається одразу, і пейдж приходить уже після нього: умова має
  триматися 3 хв. 14.10 пул наситився о 14:02, а перший пейдж прийшов о 14:06. Удень, за
  ~12 rps, це ≈45–95 невдалих запитів щохвилини (Д4). **Якщо за останню годину був деплой
  або зміна конфігу, починайте відкат у перші 10 хв після пейджа, не чекаючи, поки знайдеться
  причина.** 14.10 відкат на 45-й хвилині повернув сервіс за хвилину (`docs/rca.md`, #1, #18).

## Перші 5 хвилин

0. **Зайдіть на VM і перейдіть у каталог деплою `/opt/poshtomat`.** Усі команди `docker compose …`
   нижче запускаються звідси.

   ```bash
   ssh poshtomat-prod-1
   cd /opt/poshtomat              # каталог деплою, без git-checkout; скрипти бекапу лежать тут же (docs/ops/backup-runbook.md)
   ls compose.yaml .env               # так: обидва є → далі; ні: прод ще на старій схемі (/opt/poshtomat/repo, docker compose -f deploy/compose.yaml), див. «Запасний варіант» у блоці «Відкат»
   ```

1. **Напишіть у `#poshtomat-oncall`, що взяли пейдж.** Наприклад: «взяв(ла) ApiLatencyP95High/Api5xxRateHigh, дивлюсь».

2. **Чи живі контейнери і яка версія відповідає?**

   ```bash
   docker compose ps
   curl -s -m 5 http://localhost:8080/health; echo
   ```

   - `ps`: у `api` і `worker` STATUS має бути `Up …`. Якщо там `Restarting`, `Exited` або
     сервісу немає в списку, проблема інша: контейнер не працює. Тоді дивіться
     `docker compose logs --tail 50 api` і переходьте до кроку 3 (відкат).
     Колонка CREATED показує, коли контейнер перестворили. «Кілька хвилин тому» майже
     напевно означає деплой або ручну дію.
   - `/health` відповідає `{"status":"ok","version":"X.Y.Z"}`. **Відповідь `200` не означає,
     що сервіс здоровий**, бо `/health` не звертається до пулу БД (`app/src/server.js:37`).
     14.10 він увесь інцидент відповідав 200. Звідси беріть лише версію.

3. **Чи був деплой або зміна конфігу за останню годину? Якщо так — спершу відкат, розбиратися потім.**

   ```bash
   # Д1: старти і зупинки процесів у логах за останні 2 год
   docker compose logs --no-log-prefix --since 2h api worker | grep -e '"service started"' -e '"worker started"' -e '"shutting down"'
   # журнал деплоїв, який пише пайплайн (формат — «Довідка», «Як деплоїться»)
   tail -n 5 /opt/poshtomat/deploys.log
   # коли востаннє змінювали compose-файл і образ
   ls -l compose.yaml .env
   ```

   - **Так:** є `service started` з новою версією, запис `deploy` або `failed` у журналі
     (`failed` теж означає свіжий деплой, навіть якщо за ним є `rollback`) або свіжий час
     зміни `compose.yaml` чи `.env`, і пейдж прийшов після цього. Тоді переходьте до «Що робити»,
     рядок 1 (відкат), паралельно з кроком 4. 14.10 деплой був за 4 хв до пейджа, а відкат
     зробили лише через 45 хв.
   - **Ні:** за годину рестартів не було. Тоді причина, найімовірніше, не в релізі.
     Переходьте до «Діагностики».
   - **Обережно:** після деплою `docker compose logs` показує лише **новий** контейнер, бо
     логи старого видалено разом з ним. Тож якщо перший рядок Д1 — `service started`
     кілька хвилин тому, це вже ознака свіжого перестворення.

   Приклад на даних інциденту (вікно 13:07–14:07, тобто «остання година» на момент другого пейджа):

   ```bash
   awk -F'"' '$4 >= "2026-10-14T13:07" && $4 < "2026-10-14T14:07"' incident/logs/api-2026-10-14.jsonl | grep -e '"service started"' -e '"shutting down"'
   ```

   ```text
   {"ts":"2026-10-14T14:01:58.214+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}
   {"ts":"2026-10-14T14:02:00.087+03:00","level":"info","msg":"service started","version":"1.8.0"}
   ```

   Отже, за 5 хв до пейджа вийшла нова версія. Відповідь — «так».

4. **Який пул з'єднань насправді отримав процес?** Перевіряйте завжди, навіть без свіжого
   деплою. Вночі трафік менший, тож неправильний пул міг не дати про себе знати з вечора.
   Нічних метрик у даних немає, це **припущення**.

   ```bash
   # Д2: що бачить код (той самий loadConfig, що й сервіс; WORKDIR контейнера — /app)
   docker compose exec -T api node -e 'import("./src/config.js").then((m) => { const c = m.loadConfig(); console.log("dbPoolMax=" + c.dbPoolMax, "dbPoolWaitMs=" + c.dbPoolWaitMs); })'
   # оточення, з яким стартував процес (PID 1 — docker-init через init: true, deploy/compose.yaml:13; він запускає node з тим самим оточенням)
   docker compose exec -T api sh -c 'tr "\0" "\n" < /proc/1/environ | grep "^DB_POOL"'
   ```

   - **Норма:** `dbPoolMax=20 dbPoolWaitMs=2000` і змінні `DB_POOL_MAX=20` та
     `DB_POOL_WAIT_MS=2000`. Такі значення стоять у `deploy/compose.yaml:32-33` (спільний блок
     `x-env` для api, worker і expire), а у v1.7.3 — у `main:deploy/compose.yaml:16-17`.
   - **Проблема:** `dbPoolMax=4` означає, що `DB_POOL_MAX` не задана, порожня, `0` або не число
     (`Number(x) || 4`), і код тихо взяв дефолт для локальної розробки (`app/src/config.js:8-9`:
     коментар «sensible default for local dev» і сам дефолт). Шукайте в оточенні змінну зі
     схожою назвою (14.10 це був `DB_POOL_SIZE=20`, якого код не читає) або дивне значення.
     Рішення — «Що робити», рядок 1 або 2.
   - Ці команди не друкують `SMS_TOKEN` і `DATABASE_URL`. Не запускайте замість них `printenv` чи
     `docker compose config` без `grep`: `config` підставляє значення з `.env`, тож надрукує
     обидва секрети.

   Приклад на даних інциденту: справжній `loadConfig` з оточенням v1.8.0 (`DB_POOL_SIZE`,
   див. `incident/changes/v1.8.0.diff:86-87`) і v1.7.3 (`DB_POOL_MAX`):

   ```bash
   node -e 'import("./app/src/config.js").then((m) => { for (const env of [{ DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000" }, { DB_POOL_MAX: "20", DB_POOL_WAIT_MS: "2000" }]) { const c = m.loadConfig(env); console.log(Object.keys(env)[0], "-> dbPoolMax=" + c.dbPoolMax, "dbPoolWaitMs=" + c.dbPoolWaitMs); } })'
   ```

   ```text
   DB_POOL_SIZE -> dbPoolMax=4 dbPoolWaitMs=2000
   DB_POOL_MAX -> dbPoolMax=20 dbPoolWaitMs=2000
   ```

5. **Зніміть логи за останню годину у файли.** Усі команди «Діагностики» працюють з ними.

   ```bash
   docker compose logs --no-log-prefix --since 1h api > /tmp/api-1h.jsonl
   docker compose logs --no-log-prefix --since 1h worker > /tmp/worker-1h.jsonl
   wc -l /tmp/api-1h.jsonl /tmp/worker-1h.jsonl     # так: обидва > 0
   ```

   Прапорець `--no-log-prefix` прибирає префікс `api-1  | `, тож рядок починається з `{"ts":"`.
   На цьому тримаються `cut -c19-23` (ГГ:ХХ) нижче. Метрики дивіться на дашборді:
   `https://grafana.example.org/d/poshtomat-api`. Панелі там названо так само, як колонки в `incident/README.md`:
   `rps`, `p95_ms`, `error_rate`, `db_pool_in_use`, `db_pool_waiting`, `heap_used_pct`,
   `sms_429_per_min`.

## Діагностика

Основна розвилка — **текст помилки 5xx** (Д3) разом з метриками **`db_pool_in_use` /
`db_pool_waiting`**.

| Питання | Команда | Як читати результат |
|---|---|---|
| Які 5xx і на яких маршрутах? | Д3 | Багато `503 … db pool wait timeout after …ms` → **пул не встигає видати з'єднання**, далі рядки «пул». Багато `500` з іншим текстом → **баг у коді**: «Як підтвердити причину», гілка В; дія — «Що робити», рядок 6. Лише `500 /parcels … reading 'trim'` у звичній кількості → це фоновий баг (див. «Відомі хибні сліди»), шукайте далі |
| Коли почалися помилки? | Д4 | Перша хвилина з різким ростом збігається з `service started` з Д1 → **реліз або конфіг**. Наростало без рестарту → **БД або трафік** |
| Пул: стеля в конфігу чи в БД? | дашборд, `db_pool_in_use` і `db_pool_waiting`; поруч Д2 | `waiting` > 0, а `in_use` **тримається рівно на одному числі, меншому за 20** і дорівнює `dbPoolMax` з Д2 → **пул замалий через конфіг** (випадок 14.10: `in_use` = 4 усі 45 хв). `in_use` = 20 (= `dbPoolMax`) і `waiting` > 0 → з'єднання тримаються довго: **повільна БД** (Д6–Д8) або **трафік** (наступний рядок). Сам по собі `in_use` 4 — не ознака: 13.10 удень бували хвилини з `in_use` від 1 до 13 |
| Чи виріс трафік? | дашборд, `rps` проти того самого часу вчора | 14.10 `rps` був 11,8 проти 11,85 у звичайний день, тобто трафік не винен. Якщо rps у рази вищий і `in_use` = 20 при здоровій БД → **трафік** |
| Чи пул справді не видає з'єднання *зараз*? | Д5 | `403` за десятки мс → пул видає з'єднання. `503` після ≥ 2 с → пул насичений прямо зараз |
| Чи гальмує PostgreSQL? | Д6, Д7, Д8 | Див. пояснення під блоками. Вночі **спершу** гляньте на годинник: з 02:00 до 02:30 бекап блокує запис (Д8) |
| Чи не впирається VM? | `uptime`; `df -h /`; `docker stats --no-stream` | load average значно більший за кількість ядер (`nproc`), диск `/` заповнений на ~100 % або CPU контейнера ~100 % → проблема хоста, ескалація. Норм для цих чисел у репо немає |
| Чи це не 429 / heap / TLS? | Д9, Д10, Д11 | Див. «Відомі хибні сліди». Усе в звичній кількості → не причина, не витрачайте на це час |

**Д3. Розбивка 5xx: кількість, статус, маршрут, текст помилки**

```bash
grep '"msg":"request failed"' /tmp/api-1h.jsonl | sed -E 's/.*"path":"([^"]*)","status":([0-9]+).*"error":"([^"]*)".*/\2 \1 \3/' | sort | uniq -c | sort -rn
```

Приклад на даних інциденту (`incident/logs/api-2026-10-14.jsonl` замість `/tmp/api-1h.jsonl`, увесь день 12:00–16:00):

```text
2586 503 /pickup db pool wait timeout after 2000ms
 650 503 /parcels db pool wait timeout after 2000ms
 144 503 /admin/parcels db pool wait timeout after 2000ms
 125 500 /parcels Cannot read properties of undefined (reading 'trim')
```

Та сама команда на звичайному дні (`incident/baseline/api-2026-10-13.jsonl`) показує фон:

```text
 128 500 /parcels Cannot read properties of undefined (reading 'trim')
```

**Д4. Помилки пулу по хвилинах (ГГ:ХХ)**

```bash
grep 'db pool wait timeout' /tmp/api-1h.jsonl | cut -c19-23 | uniq -c | head -5
grep 'db pool wait timeout' /tmp/api-1h.jsonl | cut -c19-23 | uniq -c | tail -5
# те саме для всіх 5xx, якщо помилки не пулові
grep '"msg":"request failed"' /tmp/api-1h.jsonl | cut -c19-23 | uniq -c | tail -15
```

Приклад на даних інциденту (перші 5 і останні 3 хвилини):

```text
   3 14:02
  20 14:03
  46 14:04
  83 14:05
  92 14:06
...
  75 14:44
  72 14:45
  77 14:46
```

Перший таймаут з'явився о 14:02, через 7 с після `service started 1.8.0` (Д1), а останній — о
14:46, перед відкатом. На звичайному дні таких рядків **0**:
`grep -c 'db pool wait timeout' incident/baseline/api-2026-10-13.jsonl` → `0`.

**Д5. Проба через пул без побічних ефектів**

`GET /admin/parcels` з вигаданим токеном бере з'єднання з пулу, щоб знайти сесію
(`app/src/server.js:14-19`). Сесії не знаходить і відповідає `403`, нічого не змінюючи.
Для проби **не використовуйте `POST /pickup`**: справжній код видав би посилку.

```bash
probe="probe-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"   # сесія, якої немає; щоразу нова
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' -H "Authorization: Bearer $probe" http://localhost:8080/admin/parcels; done
```

- `403 0.0…s` в усіх рядках → пул видає з'єднання.
- `403`, але сотні мс або більше → пул ще видає з'єднання, але черга вже є. Проба послідовна,
  тож під навантаженням дивіться ще й `db_pool_waiting` на дашборді.
- `503 2.0…s` (час ≥ `dbPoolWaitMs`) хоча б у частині рядків → пул насичений зараз.

Приклад на коді з репо: той самий обробник з пулом на 1 з'єднання, вільним і зайнятим, та сама проба:

```bash
node -e 'Promise.all([import("./app/src/server.js"), import("./app/src/db.js"), import("./app/src/parcels.js")]).then(async ([s, d, p]) => { for (const busy of [false, true]) { const pool = d.createPool({ max: 1, waitMs: 50 }); if (busy) pool.withConnection(() => new Promise((r) => setTimeout(r, 300))); const h = s.createHandler({ parcels: p.createParcels({ pool }), authenticate: s.sessionAuth(pool), log: { info() {}, error() {} } }); const req = { method: "GET", url: "/admin/parcels", headers: { authorization: "Bearer probe-" + crypto.randomUUID() } }; const res = { writeHead(c) { this.c = c; }, end(b) { console.log(busy ? "пул зайнятий:" : "пул вільний:", this.c, b); } }; await h(req, res); } })'
```

```text
пул вільний: 403 {"error":"forbidden"}
пул зайнятий: 503 {"error":"service busy, try again"}
```

**Д6–Д8. PostgreSQL на VM.** Команди написано за зразком `docs/ops/backup-runbook.md`
(`sudo -u postgres`). На даних інциденту їх не перевірити: даних БД в `incident/` немає.

```bash
# Д6: з'єднання бази poshtomat за станом і типом очікування
sudo -u postgres psql -d poshtomat -c "select state, wait_event_type, count(*) from pg_stat_activity where datname = 'poshtomat' group by 1, 2 order by 3 desc;"
# Д7: найдовші активні запити
sudo -u postgres psql -d poshtomat -c "select pid, now() - query_start as running, state, wait_event_type, left(query, 60) as query from pg_stat_activity where datname = 'poshtomat' and state <> 'idle' order by running desc limit 10;"
# Д8: чи йде бекап і чи є заблоковані запити
date; pgrep -af backup.sh; sudo tail -n 3 /var/log/poshtomat/backup.log
sudo -u postgres psql -d poshtomat -c "select count(*) as waiting_locks from pg_locks where not granted;"
```

- **БД здорова:** майже всі з'єднання `idle` або коротко `active`, у Д7 немає запитів, що
  тривають секундами, `waiting_locks` = 0, `pgrep` нічого не виводить.
- **БД гальмує:** багато `active` з `running` у секунди, `wait_event_type` = `Lock`,
  `waiting_locks` > 0. Якщо `pgrep` знаходить `backup.sh` і зараз 02:00–02:30, це штатний
  бекап: він тримає блокування на запис (`docs/ops/backup-runbook.md`, п. 1). `POST /pickup`
  оновлює посилку (`app/src/parcels.js:64-66`), тому видача теж чекатиме.
- **Нічна задача `expire` і старі команди з backup-runbook:** о 03:15 cron запускає
  `cd /opt/poshtomat && docker compose run --rm expire` (сервіс `expire` з профілем `jobs`, з
  `up` не стартує, `deploy/compose.yaml:63-71`). Її видно в
  `docker compose --profile jobs ps -a` як окремий контейнер з власним пулом
  (`app/bin/expire-parcels.js:24`). `docs/ops/backup-runbook.md:18-19` ще називає стару форму
  (`docker compose run --rm worker npm run expire`), а `:32` —
  `docker compose -f deploy/compose.yaml stop api worker`; на новій схемі це
  `cd /opt/poshtomat && docker compose stop api worker`. У cron на VM має бути **рівно одна**
  з форм нічної задачі, інакше `expire` піде двічі.

### Відомі хибні сліди

14.10 на кожен з них пішли хвилини, хоча жоден не був причиною (`docs/rca.md`, «Що з даних
НЕ є причиною»). Нічого з цього не створює 503 у API.

**Д9. 429 від SMS-провайдера (`SmsProvider429RateHigh`, `sms provider rate limited`).**

```bash
grep -c '"sms provider rate limited"' /tmp/worker-1h.jsonl
grep -c '"sms batch sent"' /tmp/worker-1h.jsonl
grep -c 'sms' /tmp/api-1h.jsonl
```

Приклад на даних інциденту (за 12:00–16:00, той самий `grep -c` на 14.10 і 13.10):

```text
incident/logs/worker-2026-10-14.jsonl:3065
incident/baseline/worker-2026-10-13.jsonl:2935      ← 429 стільки ж у звичайний день
```

Ці 429 спричиняв наш власний темп 20/с при ліміті провайдера 10/с: їх отримував кожен раунд
worker-а з понад 10 SMS і жоден з ≤ 10 (`docs/rca.md`, «НЕ є причиною», рядок 1). Тепер
`SMS_RATE_PER_SEC: "8"` (`deploy/compose.yaml:35`), тож норма — ≈ 0 (модель у post-mortem, дія 6, дає 0;
на проді ще не перевірено). Якщо 429 знову багато, перевірте темп:
`docker compose exec -T worker sh -c 'tr "\0" "\n" < /proc/1/environ | grep "^SMS_RATE"'` → так:
`SMS_RATE_PER_SEC=8`.

API-лог 14.10 на `sms` → `0`. До SMS-провайдера ходить лише worker, і з'єднання з БД при
цьому не тримає (`app/src/worker.js:24-33`). 429 у будь-якій кількості **не пояснюють 503 в
API**. Справжня проблема з SMS — це коли `"sms batch sent"` = 0 за годину, тобто SMS не
йдуть зовсім. Це окрема проблема, вночі її не розв'язують.

**Д10. «Витік пам'яті»: `heap usage high`, heap 75–82 %.**

```bash
grep -c '"heap usage high"' /tmp/api-1h.jsonl
docker inspect -f 'status={{.State.Status}} OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}}' $(docker compose ps -q api)
```

Попередження пишеться, коли heap ≥ 75 % (`app/src/server.js:83`). Це нормальна пилка GC.
Приклад на даних інциденту: `63` попередження 14.10 проти `70` 13.10, максимум heap обидва
дні 82 %. Причиною це було б лише при `OOMKilled=true` або якщо `restarts` росте. Тоді
контейнер падає, а не відповідає 503.

**Д11. Поодинокий `TLS handshake timeout to sms.example.net`.**

```bash
grep -c 'TLS handshake timeout' /tmp/worker-1h.jsonl
```

Приклад на даних інциденту: `1` 14.10 і `1` 13.10, тобто такий рядок буває й у звичайний
день. Він стосується тільки worker-а. Значення має лише серія таких рядків, і то для SMS, а
не для API.

**Фоновий 500 `Cannot read properties of undefined (reading 'trim')` на `POST /parcels`.**
Це старий баг: `sender.trim()` без перевірки (`app/src/parcels.js:42`). Удень його
трапляється від кількох до ~75 на годину, і обидва дні однаково. Приклад на даних інциденту
(кількість за годину, 12–15):

```bash
grep "reading 'trim'" incident/baseline/api-2026-10-13.jsonl incident/logs/api-2026-10-14.jsonl | cut -d'"' -f4 | cut -c1-13 | uniq -c
```

```text
   6 2026-10-13T12
  43 2026-10-13T13
  74 2026-10-13T14
   5 2026-10-13T15
   4 2026-10-14T12
  43 2026-10-14T13
  71 2026-10-14T14
   7 2026-10-14T15
```

Сам `Api5xxRateHigh` він не спричиняє: середній `error_rate` у звичайний день 0,002 при
порозі 0,05.

## Як підтвердити причину

**А. Пул замалий через конфіг (причина 14.10).** Мають збігтися обидва факти:
1. Д2 показує `dbPoolMax` менше 20, наприклад `4`, а в `/proc/1/environ` немає
   `DB_POOL_MAX=20`;
2. на дашборді `db_pool_in_use` стоїть **рівно** на цьому числі, а `db_pool_waiting` > 0.

Приклад на даних інциденту (`awk -F, 'NR==1 || (substr($1,12,5)>="14:00" && substr($1,12,5)<"14:05")' incident/metrics/2026-10-14.csv | cut -d, -f1-6`):

```text
ts,rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting
2026-10-14T14:00:00+03:00,11.7,251,0.0014,12,0
2026-10-14T14:01:00+03:00,11.3,245,0.0044,12,0
2026-10-14T14:02:00+03:00,11.9,945,0.0042,4,4
2026-10-14T14:03:00+03:00,11,2446,0.0333,4,10
2026-10-14T14:04:00+03:00,11.7,3477,0.0684,4,15
```

Трафік той самий, `in_use` впав з 12 до 4 у хвилину деплою, і з'явилася черга. Звідки
взялася назва змінної, видно, якщо порівняти, що задає compose і що читає код:

```bash
docker compose config | grep -E '^ +DB_POOL'
docker compose exec -T api grep -n 'DB_POOL' src/config.js
```

На даних інциденту (`grep -n 'DB_POOL' incident/changes/v1.8.0.diff` і `grep -n 'DB_POOL' app/src/config.js`):
compose v1.8.0 задавав `DB_POOL_SIZE: "20"` (`v1.8.0.diff:87`, `:107`), а код читає лише
`dbPoolMax: Number(env.DB_POOL_MAX) || 4` (`config.js:9`).
Майте на увазі: `config` показує файл на диску, а `/proc/1/environ` — оточення, з яким
стартував процес. Якщо вони різняться, файл змінили, а контейнер не перестворили.

**Б. Повільний PostgreSQL.** `db_pool_in_use` досягає `dbPoolMax` (20), а Д6–Д8 показують
довгі `active` запити, блокування або бекап. Конфіг з Д2 при цьому в нормі.

**В. Поганий реліз (код).** Д3 показує новий текст помилки, якого не було до деплою. Д4
показує, що він з'явився в першу хвилину після `service started`. Щоб порівняти «до» і «після»,
відфільтруйте `/tmp/api-1h.jsonl` за часом деплою (`<ЧАС>` у форматі `ГГГГ-ММ-ДДTГГ:ХХ`, наприклад `2026-10-14T14:02`):

```bash
awk -F'"' '$4 < "<ЧАС>"' /tmp/api-1h.jsonl | grep '"msg":"request failed"' | sed -E 's/.*"path":"([^"]*)","status":([0-9]+).*"error":"([^"]*)".*/\2 \1 \3/' | sort | uniq -c | sort -rn
awk -F'"' '$4 >= "<ЧАС>"' /tmp/api-1h.jsonl | grep '"msg":"request failed"' | sed -E 's/.*"path":"([^"]*)","status":([0-9]+).*"error":"([^"]*)".*/\2 \1 \3/' | sort | uniq -c | sort -rn
```

Приклад на даних інциденту (вікно 13:07–14:07, тобто перший рядок `awk` з кроку 3 замість
`/tmp/api-1h.jsonl`, `<ЧАС>` = `2026-10-14T14:02`). До деплою був лише фоновий 500, а після
нього з'явився новий тип помилки:

```text
до 14:02:
  46 500 /parcels Cannot read properties of undefined (reading 'trim')

з 14:02:
 186 503 /pickup db pool wait timeout after 2000ms
  47 503 /parcels db pool wait timeout after 2000ms
  11 503 /admin/parcels db pool wait timeout after 2000ms
   7 500 /parcels Cannot read properties of undefined (reading 'trim')
```

**Г. Трафік.** `rps` у рази вищий, ніж о цій порі вчора, `in_use` = 20, а БД (Д6–Д8)
здорова.

Якщо жодна гілка не підтверджується, а деплой за останню годину був, усе одно відкочуйте.
14.10 відкат «на всяк випадок» виявився саме тим, що треба (`incident/deploys.log:9`).

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| 1. Пейдж прийшов протягом години після деплою або зміни конфігу (крок 3 = «так»), незалежно від гілки | **Відкат** на попередню версію: **і код, і `compose.yaml`** | блок «Відкат» нижче | Секунди недоступності під час перестворення. Образ задано за digest (`deploy/compose.yaml:12`), тож відкат повертає саме попередній образ. Неправильний `DB_POOL_MAX` автовідкат пайплайна вже ловить (перевірка пулу після деплою, «Довідка»), а інші проблеми, яких не видно з `/health`, — ні. **Після:** перевірки з блоку «Відкат», Д5 = 403, далі «Як переконатися». 14.10 сервіс відновився за хвилину після відкату |
| 2. Д2 показує неправильний пул, а відкат неможливий або версія потрібна | Виправити назву або значення змінної в `/opt/poshtomat/compose.yaml` (вона задається один раз у блоці `x-env`, `deploy/compose.yaml:29-39`, для `api`, `worker` і `expire`) і **перестворити** контейнери | блок «Виправити env і перестворити» нижче | Правку треба внести в репо (див. блок): ескалація до автора релізу. **Після:** Д2 = `dbPoolMax=20`, у `/proc/1/environ` є `DB_POOL_MAX=20` |
| 3. Хочеться «просто перезапустити» | **Не допоможе, якщо причина в конфігу.** `docker compose restart` не перечитує `compose.yaml` і піднімає процес з тим самим оточенням | — | 14.10 рестарт о 14:20 на тій самій версії дав одну хвилину з `waiting` 6, а о 14:21 знову `in_use` 4, `waiting` 20 (`docs/rca.md`, #18). Рестарт має сенс лише тоді, коли процес завис, а конфіг (Д2) у нормі |
| 4. Бекап 02:00–02:30 тримає блокування (Д8) | Не чіпати бекап. Написати в `#poshtomat-oncall`, що причина — вікно бекапу, і чекати 02:30 | `sudo tail -n 3 /var/log/poshtomat/backup.log` | Якщо зупинити бекап, лишиться неузгоджена копія (`docs/ops/backup-runbook.md`). **Після 02:30:** Д5 = 403. Якщо не відпустило — ескалація до власника БД. Повторюваність варто винести на розбір |
| 5. Довгі запити або блокування в PostgreSQL поза вікном бекапу (Д6–Д8) | Ескалація до власника БД. Скасувати конкретний запит **лише за його згодою** | `sudo -u postgres psql -d poshtomat -c "select pg_cancel_backend(<PID з Д7>);"` (наприклад `pg_cancel_backend(48213)`) | Можна скасувати чужу важливу операцію (бекап, міграцію, `expire`). **Після:** Д7 без довгих запитів, `db_pool_in_use` нижче 20, Д5 = 403 |
| 6. Новий 500 з'явився після деплою (гілка В) | Відкат, як у рядку 1 | блок «Відкат» | Те саме, що в рядку 1. **Після:** Д3 за 15 хв без нового тексту помилки |
| 7. Пул упирається в 20 через трафік, БД здорова | Ескалація. Самостійно вночі `DB_POOL_MAX` не піднімати | — | Більший пул означає більше з'єднань до PostgreSQL, а `max_connections` = 100 (дефолт). Уже зараз api 20 + worker 20 + нічний `expire` 20 = 60 зі 100, тож підняття `DB_POOL_MAX` вирішує лише ескалація, не черговий уночі |
| 8. API в нормі (Д3 без пулових 503, Д5 = 403), горять лише 429 / heap / TLS | Нічого не робити вночі, записати в чат | — | Див. «Відомі хибні сліди» |

**Відкат.** Пайплайн, коли деплой щось змінює (образ, `compose.yaml` або секрети), зберігає
попередні `compose.yaml` і `.env` як `*.prev`, лише на один крок назад.
Попередній образ ще є на VM, тож відкат нічого не збирає і не тягне. Файли належать
користувачу деплою, а `.env*` містять секрети і мають права 0600, тому команди нижче виконуйте від нього
(`sudo -u <DEPLOY_USER> …` або увійшовши під ним).

Спершу подивіться, чи є куди відкочуватися:

```bash
cd /opt/poshtomat
tail -n 5 deploys.log                # останні записи: дія, sha, хто, образ
ls .env.prev                         # немає → «Запасний варіант» нижче
for f in compose.yaml .env; do cmp -s "$f" "$f.prev" || echo "$f відрізняється"; done
```

Далі перша гілка, що підходить:

- **(а) Останній рядок журналу закінчується на `unchanged`** → це повторний деплой того самого
  релізу: файли на диску — його, а `*.prev` — реліз **до** нього. З `*.prev` нічого не копіюйте.
  `docker compose ps` і Д5: якщо `api` не `healthy` або Д5 не 403, перестворіть той самий реліз
  (`docker compose up -d --wait --force-recreate api worker`; файли не змінилися, тож без
  `--force-recreate` compose лишить наявні контейнери як є) і повторіть `docker compose ps` та Д5.
  Відкат з `*.prev` (гілка (д)) —
  лише якщо винен сам цей реліз: його перший `deploy` у журналі був за годину до пейджа.
- **(б) `.env.prev` немає** → «Запасний варіант» нижче: за новою схемою був лише один деплой
  або жодного, і попередній стан є лише на старій схемі.
- **(в) Останній рядок журналу — `failed` без `rollback` після нього, а деплой у GitHub Actions
  уже завершився** → автовідкат не піднявся або не пройшов перевірку пулу. Поки workflow ще йде (автовідкат чекає `up --wait`
  до 90 с), `failed` теж стоїть останнім — спершу дочекайтеся кінця.
  Ескалація до розробника; паралельно `docker compose ps` і `docker compose logs --tail 50 api worker`.
- **(г) `cmp` нічого не вивів** → на крок назад відкочуватися нема куди. Або пайплайн уже
  відкотив сам (у журналі `failed X`, потім `rollback Y`), або щойно відкотили вручну.
  Повторіть Д2. Якщо проблема лишається, перезапустіть (Re-run) деплой старішого успішного
  прогону в GitHub Actions (його образ є в GHCR) і ескалюйте до розробника.
- **(д) Інакше** — відкат з `*.prev`:

  ```bash
  grep '^POSHTOMAT_' .env .env.prev    # що зараз і на що відкочуємося; лише ці рядки — решта .env секрети
  for f in compose.yaml .env; do cp -p "$f" "$f.before-oncall"; done   # зберегти поточний стан
  for f in compose.yaml .env; do cp -p "$f.prev" "$f"; done            # повернути і образ, і секрети, і compose.yaml
  docker compose up -d --wait api worker
  docker compose ps --format '{{.Service}} {{.Image}}'   # так: в api і worker той самий образ, що й POSHTOMAT_IMAGE нижче
  grep '^POSHTOMAT_IMAGE=' .env
  curl -s -m 5 http://localhost:8080/health; echo        # так: відповідає (лише «живий»)
  ```

  `"version"` з `/health` — це версія з `app/package.json` (`app/src/version.js:3-5`). У
  сусідніх релізів вона може бути однакова, тож чи відкотився образ, перевіряйте за
  `docker compose ps`.

  Потім повторіть Д2 (так: `dbPoolMax=20`) і допишіть відкат у журнал, у форматі пайплайна:

  ```bash
  to=$(sed -n 's/^POSHTOMAT_SHA=//p' .env); failed=$(sed -n 's/^POSHTOMAT_SHA=//p' .env.before-oncall)
  printf '%s   rollback  %s  %s  failed %s\n' "$(date -Iseconds)" "${to:-unknown}" "<ХТО>" "${failed:-unknown}" >> deploys.log
  tail -n 1 deploys.log
  ```

Відкочувати треба **разом з `compose.yaml`**. 14.10 код API у v1.7.3 і v1.8.0 був
однаковий, а сервіс полагодило повернення `DB_POOL_MAX` (`docs/rca.md`, «Першопричина», п. 5).

**Запасний варіант: немає `.env.prev`.** Отже, за новою схемою був лише один деплой або
жодного (перший деплой `*.prev` не створює), і попередній стан є лише на старій схемі:
git-checkout у `/opt/poshtomat/repo`, образ збирається на VM. Якщо новий стек запущено, він
тримає порт 8080, тож спершу зупиніть його:

```bash
cd /opt/poshtomat && docker compose stop api worker
cd /opt/poshtomat/repo
git status --short                   # так: порожньо; ні: хтось правив файли на VM — напишіть у чат і не губіть цих змін
git checkout <ПОПЕРЕДНЯ_ВЕРСІЯ>       # наприклад v1.7.3; повертає і app/, і deploy/compose.yaml
docker compose -f deploy/compose.yaml up -d --build api worker
curl -s -m 5 http://localhost:8080/health; echo   # так: відповідає; "version" може збігатися із сусіднім релізом
```

На старій схемі решта команд runbook запускається з `/opt/poshtomat/repo` як
`docker compose -f deploy/compose.yaml …`. Старий стек тепер тримає 8080, тож перед наступним
деплоєм пайплайна його треба зупинити: `cd /opt/poshtomat/repo && docker compose -f deploy/compose.yaml down`.

**Виправити env і перестворити.**

```bash
cd /opt/poshtomat
grep -n 'DB_POOL' compose.yaml     # шукайте назву, яку код не читає (код читає лише DB_POOL_MAX і DB_POOL_WAIT_MS)
cp -p compose.yaml compose.yaml.before-oncall
sed -i.bak 's/DB_POOL_SIZE:/DB_POOL_MAX:/' compose.yaml   # приклад для випадку 14.10; підставте свою назву
grep -n 'DB_POOL' compose.yaml     # так: стоїть DB_POOL_MAX: "20" (у поточному compose — один раз, у блоці x-env для всіх сервісів)
docker compose up -d api worker    # саме up -d, не restart: лише так нове оточення потрапить у контейнер
```

Потім повторіть Д2. Ви маєте побачити `dbPoolMax=20 dbPoolWaitMs=2000`. Наступний деплой
перезапише `/opt/poshtomat/compose.yaml` версією з репо, тож ту саму правку внесіть у
`deploy/compose.yaml` у репо і перевірте `node tools/check-deploy.mjs` (звірку назв з кодом робить правило E1).
У CI крок перевірки конфігу запускає правила D*, C* і E1, але не W*: W-правила перевіряють сам
workflow за шляхом `pipeline/deploy.yml`, а в робочому репо він лежить у `.github/workflows/`.

## Коли ескалювати і кого кликати

Канал для всього нижче — `#poshtomat-oncall` (`incident/alerts.json`, `docs/ops/backup-runbook.md`).
Пошта команди — `poshtomat-team@example.org`.

- **Відкат зроблено, а через 10 хв Д5 і далі дає 503** або `p95_ms` > 2000 (тоді й автор
  останнього релізу, колонка «хто» в `deploys.log`), **або через 15 хв після пейджа не
  вдалося визначити гілку, а деплою не було** → розробник на зв'язку: `#poshtomat-dev`,
  телефон `+380000000101`.
- **Гілка Б (PostgreSQL), будь-який `pg_cancel_backend`, бекап не відпустив після 02:30** →
  власник БД і бекапів (власник `docs/ops/backup-runbook.md`): `#poshtomat-db`, телефон `+380000000102`.
- **Хост: диск, CPU, VM не відповідає по ssh** → адміністратор VM: `#infra-oncall`, `infra-oncall@example.org`.
- **Поштомати не видають посилки довше за 15 хв** → координатор гарячої лінії, який
  повідомляє громаду (14.10 гаряча лінія дізналася раніше за чергову, `incident/oncall-chat.md:9`):
  `hotline@example.org`, телефон `+380000000103`.
- **SMS-провайдер** — лише якщо `"sms batch sent"` = 0 за годину (Д9) →
  `support@sms.example.net`. Самі 429 — не привід.

## Як переконатися, що все гаразд

Те, що закрилися пейджі, ще нічого не гарантує: пороги алертів (p95 < 2000 мс,
`error_rate` < 0,05) набагато вищі за норму. Звіряйтеся з нормою. Нижче — денні значення
13.10 і 14.10 до деплою та після відкату, бо інших даних немає. **Нічних норм у репо немає.**

| Що | Норма | Звідки |
|---|---|---|
| `p95_ms` | 140–300 мс | 13.10: 140–260; 14.10 після відкату (з 14:48): 140–296 |
| `error_rate` | ≤ ~0,007 | 13.10: 0–0,0069 (у середньому 0,002); 14.10 після відкату: 0–0,0072 |
| `db_pool_waiting` | **0 щохвилини** | 13.10 і 14.10 після відкату: жодної хвилини з `waiting` > 0 |
| `db_pool_in_use` | 1–13 залежно від трафіку (удень 10–13), нижче за `dbPoolMax` | 13.10: 1–13; 14.10 після відкату: 2–12; удень 10–13 (`docs/rca.md` #15–#17) |

Джерело чисел: мінімум і максимум кожної колонки за весь файл 13.10 і за 14.10 з 14:48 (приклад на даних інциденту):

```bash
node -e 'const [f, from] = process.argv.slice(1); const [head, ...rows] = require("fs").readFileSync(f, "utf8").trim().split("\n"); const h = head.split(","); const L = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from); for (const i of [2, 3, 4, 5]) { const v = L.map((r) => +r[i]); console.log(h[i], Math.min(...v) + ".." + Math.max(...v)); }' incident/baseline/metrics-2026-10-13.csv 12:00
node -e 'const [f, from] = process.argv.slice(1); const [head, ...rows] = require("fs").readFileSync(f, "utf8").trim().split("\n"); const h = head.split(","); const L = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from); for (const i of [2, 3, 4, 5]) { const v = L.map((r) => +r[i]); console.log(h[i], Math.min(...v) + ".." + Math.max(...v)); }' incident/metrics/2026-10-14.csv 14:48
```

```text
p95_ms 140..260
error_rate 0..0.0069
db_pool_in_use 1..13
db_pool_waiting 0..0
p95_ms 140..296
error_rate 0..0.0072
db_pool_in_use 2..12
db_pool_waiting 0..0
```

Перевірки на VM:

```bash
# пулових таймаутів за останні 5 хв немає
docker compose logs --no-log-prefix --since 5m api | grep -c 'db pool wait timeout'   # так: 0
# 5xx за останні 5 хв — лише фонові, якщо є
docker compose logs --no-log-prefix --since 5m api | grep '"msg":"request failed"' | sed -E 's/.*"path":"([^"]*)","status":([0-9]+).*"error":"([^"]*)".*/\2 \1 \3/' | sort | uniq -c
# проба через пул (Д5): усі 10 рядків — 403 за десятки мс
probe="probe-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"   # сесія, якої немає; щоразу нова
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' -H "Authorization: Bearer $probe" http://localhost:8080/admin/parcels; done
# пул правильний (Д2)
docker compose exec -T api node -e 'import("./src/config.js").then((m) => { const c = m.loadConfig(); console.log("dbPoolMax=" + c.dbPoolMax, "dbPoolWaitMs=" + c.dbPoolWaitMs); })'   # так: dbPoolMax=20
```

**Скільки дивитися:** щонайменше **15 хв** поспіль у нормі, і лише тоді оголошувати
відновлення. Одна добра хвилина нічого не доводить: 14.10 після рестарту о 14:20 черга
на хвилину спала до 6, а о 14:21 знову була 20 (`docs/rca.md` #18). Попросіть координатора
гарячої лінії підтвердити, що посилка видається: він дзвонить на поштомат-точку або кур'єру
на маршруті (`hotline@example.org`, телефон `+380000000103`).

**Після відновлення:**
- напишіть у `#poshtomat-oncall`, що зроблено і о котрій;
- якщо відкочували вручну, перевірте, що в `deploys.log` є рядок `rollback` (блок «Відкат»);
- якщо `compose.yaml` правили руками (рядок 2 у «Що робити»), передайте правку автору релізу,
  щоб її внесли в `deploy/compose.yaml` у репо. Інакше наступний деплой перезапише
  `/opt/poshtomat/compose.yaml` і поверне проблему.

## Довідка

**Як влаштований прод** (`deploy/compose.yaml`, `pipeline/deploy.yml`, `docs/ops/backup-runbook.md`):
одна VM `poshtomat-prod-1`, на ній docker compose з двома сервісами, `api` (порт `8080`) і
`worker` (SMS), плюс нічна задача `expire`. PostgreSQL працює на тій самій VM, поза compose.
Кожен процес має власний пул з'єднань до БД. Його розмір задає `DB_POOL_MAX`, а час
очікування вільного з'єднання — `DB_POOL_WAIT_MS` (`app/src/config.js:9-10`). Якщо запит не
дочекався з'єднання, API відповідає `503 {"error":"service busy, try again"}` і пише в лог
`"error":"db pool wait timeout after 2000ms"` (`app/src/db.js:6`, `app/src/server.js:65`).
Будь-яка інша неперехоплена помилка дає `500 {"error":"internal error"}`.

**Як деплоїться** (`pipeline/deploy.yml`, `deploy/compose.yaml:1-9`). Образ збирає CI і пушить у
GHCR; на VM нічого не збирається, git-checkout там немає. Перш ніж щось змінити, пайплайн
розбирає новий `compose.yaml` тим Compose, що стоїть на VM (`docker compose config --quiet`):
файл, якого цей Compose не розуміє, не потрапить на диск (так 27.10 Compose 2.2.3 не прочитав
давню форму `env_file:`, `docs/task-e-bonus.md`). Усе лежить у каталозі `/opt/poshtomat`, файли
належать користувачу деплою:

- `compose.yaml` — копія `deploy/compose.yaml` з репо на момент деплою;
- `.env` (права 0600) — `POSHTOMAT_IMAGE=<образ@sha256:…>`, `POSHTOMAT_SHA=<коротке sha релізу>`,
  `DATABASE_URL` і `SMS_TOKEN`. Compose підставляє з нього `${…:?…}` у `compose.yaml`;
- `compose.yaml.prev`, `.env.prev` (`.env.prev` теж 0600) — стан до
  останнього деплою, який **щось змінив**: образ, `compose.yaml` або секрети. Це **лише один крок назад**. Деплой
  без жодних змін `*.prev` не чіпає. Перший деплой за новою схемою `*.prev` не створює
  (поточних файлів ще немає), тож вони з'являються з другого деплою, що щось змінив.
  `secrets.env` лишився від попередньої схеми: його читає лише `compose.yaml.prev` тієї схеми;
- `deploys.log` — журнал, який пише пайплайн:
  - `<час> deploy <sha> <хто> <образ>` — реліз піднявся;
  - `<час> failed <sha> <хто> <образ>` — реліз `unhealthy`; пишеться одразу, ще до спроби автовідкату;
  - `<час> failed <sha> <хто> <образ>  unchanged` — повторний деплой того самого релізу (файли не
    змінилися) не пройшов перевірку. Відкату немає й не має бути: `*.prev` — це реліз **до** нього.
    На диску й у контейнерах лишається той самий `<sha>`, але чи він здоровий — невідомо: спершу
    `docker compose ps` і Д5, потім рішення, чи повторювати деплой (гілка (а) у «Відкат»);
  - `<час> rollback <sha, на яке відкотилися, або unknown> <хто> failed <sha>` — автовідкат
    піднявся і пройшов ту саму перевірку пулу, що й реліз. Якщо `failed` (без `unchanged`)
    стоїть останнім без `rollback` після нього, а workflow деплою вже завершився, автовідкат
    не піднявся або не пройшов перевірку. Поки workflow іде, це проміжний стан.

Пайплайн сам відкочує реліз, якщо після `docker compose up --wait` сервіс `unhealthy` або не
пройшла перевірка пулу: `printenv DB_POOL_MAX` в `api` порожній чи не збігається з `dbPoolMax`,
який бере код, або проба `GET /admin/parcels` із сесією, якої немає, дає не `403`. Він копіює
`*.prev` назад, тож після автовідкату `*.prev` лишаються і дорівнюють поточним файлам.
Healthcheck ходить у `/health` (`deploy/Dockerfile:24-25`), а той завжди відповідає 200
(`app/src/server.js:37`). Тому перейменовану змінну пулу, як 14.10, автовідкат ловить (перевірено
на Docker: реліз з `DB_POOL_SIZE` відкочено, `docs/task-e-bonus.md`), а насичення пулу під
реальним трафіком після деплою — ні: тоді відкат ручний, за цим runbook.

**Як читати логи.** Логи — це JSON lines з полями `ts`, `level`, `msg`. API пише **кожну**
відповідь 5xx як `"msg":"request failed"` з полями `method`, `path`, `status`, `ms` і `error`.
Інші відповіді він пише лише кожну соту, як `"msg":"request"`. `/health` у лог не потрапляє
(`app/src/server.js:73-75`). Тому рахуйте 5xx з логів, а частку помилок беріть з метрик.

**Чому команди Д1…Д11 — окремими блоками.** З markdown-таблиці команди з `|` копіюються з
поламаними `\|`.
