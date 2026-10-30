# RCA: інцидент 2026-10-14

Усі команди запускаються з кореня репо (Git Bash / macOS). У таблицях `\|` у команді означає
звичайний `|`. Багаторядковий вивід показано як окремі рядки, розділені `<br>`. Номери «#N»
посилаються на рядки таблиці «Докази». `main:deploy/…` — файл у стані до Task D (v1.7.3):
Task D змінив `deploy/`, тож ці рядки читаються командою `git show main:deploy/compose.yaml`.

## Коротко

14.10 з 14:02 до 14:47 API відповідав 503 `service busy, try again`. Частка 5xx у середньому —
10,7 % запитів (середнє хвилинних `error_rate`), і 98,5 % з цих 5xx — це 503 (#34). Серед них 2586 запитів видачі посилки `POST /pickup` (#14, #19, #22).
Поштомати в цей час показували «Сервіс зайнятий». Що це саме відображення відповіді 503 —
**припущення** (див. «Першопричина», п. 3, і #27).
Причина: реліз v1.8.0 («config cleanup») перейменував у `compose.yaml` змінну `DB_POOL_MAX` на
`DB_POOL_SIZE`. Код читає лише `DB_POOL_MAX`, тож пул з'єднань API тихо впав до дефолту
4 замість 20 (#4–#9, #13). Перезапуск піднімав ту саму конфігурацію. Відкат на v1.7.3 о 14:47
повернув `DB_POOL_MAX: "20"`, і сервіс відновився за хвилину (#1, #17, #18).

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 13:28 | Перший `sms provider rate limited` (429) у worker-і. 13.10 перший такий рядок був о 13:24 | `grep '"sms provider rate limited"' incident/logs/worker-2026-10-14.jsonl \| cut -c19-23 \| sed -n '1p;$p'` (див. «НЕ є причиною», рядок 1) |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning) | `incident/alerts.json`, #28 |
| 14:01:37 | Поодинокий `sms send failed: TLS handshake timeout to sms.example.net` у worker-і | `grep 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl` (див. «НЕ є причиною», рядок 2) |
| 14:01:58–14:02:07 | Деплой v1.8.0: SIGTERM старому API о 14:01:58, `service started 1.8.0` о 14:02:00.087. Worker: SIGTERM о 14:01:59, старт 1.8.0 о 14:02:07 | `incident/deploys.log:7`, #1, #2, #3 |
| 14:02 | `db_pool_in_use` падає з 12 до 4, `db_pool_waiting` = 4, p95 945 мс | `incident/metrics/2026-10-14.csv`, #18 |
| 14:02:07.172 | Перший 503 `db pool wait timeout after 2000ms` | #21 |
| 14:06 / 14:07 | Пейджі `ApiLatencyP95High` і `Api5xxRateHigh` | #28 |
| 14:08 | Гаряча лінія: поштомати показують «Сервіс зайнятий, спробуйте пізніше» | `incident/oncall-chat.md:9`, #27 |
| 14:10–14:14 | Чергова підозрює 429 від SMS-провайдера, витік пам'яті (heap 81 %) і TLS-таймаут. Автор релізу пише, що в 1.8.0 «нічого суттєвого — причесав конфіг і текст SMS» | `grep -n -e '14:10' -e '14:12' -e '14:13' -e '14:14' incident/oncall-chat.md` |
| 14:17 | Звернення в підтримку SMS-провайдера | `incident/oncall-chat.md:14` |
| 14:20:31 | Перезапуск лише API, та сама v1.8.0 | `incident/deploys.log:8`, #1, #2 |
| 14:21 | Після рестарту знову `in_use` 4, `waiting` 20, p95 4588 мс | #18 |
| 14:24 | «не допомогло… 503 сиплються далі» | `incident/oncall-chat.md:16` |
| 14:29 | `/health` весь час відповідає 200 | `incident/oncall-chat.md:17`, #26 |
| 14:36 | Провайдер SMS: «у них інцидентів немає» | `incident/oncall-chat.md:18` |
| 14:46:58.204 | Останній 503 | #21 |
| 14:47:00 | Відкат на v1.7.3: API `service started 1.7.3` о 14:47:00.236, worker о 14:47:01 | `incident/deploys.log:9`, #1, #2, #3 |
| 14:47 | `in_use` 14, `waiting` 0, p95 618 мс, error_rate 0,0014 | #18 |
| 14:48 | Пейджі API закрито. З 14:48 p95 199..296 мс | #28, #17 |
| 15:01 / 15:03 | Останній 429 у worker-і (13.10 теж о 15:01). Алерт SMS закрито | «НЕ є причиною», рядок 1; #28 |

## Першопричина

Ланцюжок механізму, ланка за ланкою:

1. **Що змінилося.** Реліз v1.8.0 відсортував змінні оточення в `compose.yaml` за
   алфавітом (#31) і заодно перейменував для обох сервісів `DB_POOL_MAX: "20"` на
   `DB_POOL_SIZE: "20"` (#4). До релізу, тобто у стані v1.7.3, який лежить у
   `deploy/compose.yaml`, там був саме `DB_POOL_MAX: "20"` (#5). Код API реліз не чіпав:
   у diff немає `app/src/config.js`, `db.js` чи `server.js` (#8).
2. **Що через це стало інакше.** `loadConfig` читає тільки `DB_POOL_MAX`. Якщо змінної
   немає, він тихо бере дефолт `4` («sensible default for local dev») (#6, #30). Назву
   `DB_POOL_SIZE` у `app/` не читає жоден файл (#7). Справжній `loadConfig` з env v1.8.0
   повертає `dbPoolMax 4`, а з env v1.7.3 повертає `20` (#9). API створює пул саме з цим
   `max` (#10). Метрика це підтверджує: усі 45 хвилин на v1.8.0 `db_pool_in_use` дорівнює
   рівно 4 (#13). За той самий проміжок 13.10 і перед деплоєм 14.10 він був 10..13 (#15, #16).
3. **Чому саме «Сервіс зайнятий».** Трафік не змінився: rps 11,8 проти 11,85 у baseline (#14, #15).
   Тепер йому вистачало 4 з'єднань замість потрібних 10–13, тож запити ставали в чергу
   (`db_pool_waiting` до 23) (#14). Хто чекав довше за `DB_POOL_WAIT_MS` = 2000 мс
   (значення не змінювалося, #4), отримував `PoolTimeoutError` (#11). Сервер перетворює
   цю помилку на `503 {"error":"service busy, try again"}` (#12). Так закінчилися всі 3380
   відповідей 503 того дня, а 13.10 таких не було жодної (#19). Найбільше їх припало на
   `/pickup`, 2586 (#22), головно тому, що це ≈72 % трафіку (#23). Те, що `pickup()` бере
   з'єднання тричі поспіль (#24), додає лише кілька відсоткових пунктів: ≈77 % серед
   відповідей 503 проти ≈72 % трафіку (#22, #23). Поштомат після введення коду викликає
   саме `/pickup` (#33).
   Український текст «Сервіс зайнятий, спробуйте пізніше» показує клієнт поштомата, а не
   API: у `app/` і `deploy/` такого рядка немає (#27). Те, що термінал перекладає 503
   `service busy` у цей текст, — **припущення**: коду термінала в репо немає.
4. **Чому перезапуск не допоміг.** О 14:20 перезапустили лише API на тій самій v1.8.0 (#1, #2).
   Процес знову прочитав те саме оточення без `DB_POOL_MAX` і знову отримав пул на 4.
   О 14:20 черга на мить спала до 6, а о 14:21 вже знову `in_use` 4, `waiting` 20 (#18).
   Проблема не в стані процесу, а в його конфігурації.
5. **Чому відкат усе виправив.** Відкат на v1.7.3 о 14:47 (#1) повернув оточення з
   `DB_POOL_MAX: "20"` (#5, #9). Уже в першу хвилину `db_pool_in_use` = 14, тобто понад 4:
   пул знову широкий. `waiting` = 0, а p95 упав з 4697 до 618 мс, далі 199..296 мс (#17, #18).
   Останній 503 зафіксовано о 14:46:58, за 2 секунди до старту 1.7.3 (#21). Код API у v1.7.3
   і v1.8.0 однаковий (#8), тож допоміг саме повернутий compose, а не образ. Що на VM відкат
   повернув і compose-файл, видно лише непрямо, з `in_use` 14 > 4 (#18). Прямого доказу
   (конфіга контейнера) у даних немає.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | 14.10 були деплой v1.8.0 о 14:02:00, перезапуск лише API на v1.8.0 о 14:20:31 і відкат на v1.7.3 о 14:47:00 | `grep '2026-10-14' incident/deploys.log` | `2026-10-14T14:02:00+03:00   deploy    v1.8.0   andrii  config cleanup (#212)`<br>`2026-10-14T14:20:31+03:00   restart   v1.8.0   olena   api only, on-call`<br>`2026-10-14T14:47:00+03:00   rollback  v1.7.3   olena   on-call, just in case` |
| 2 | Процес API тричі стартував: 1.8.0, знову 1.8.0, потім 1.7.3 | `grep '"service started"' incident/logs/api-2026-10-14.jsonl \| cut -d'"' -f4,16` | `2026-10-14T14:02:00.087+03:00"1.8.0`<br>`2026-10-14T14:20:31.112+03:00"1.8.0`<br>`2026-10-14T14:47:00.236+03:00"1.7.3` |
| 3 | Worker перезапускався лише під час деплою й відкату | `grep -e 'worker started' -e 'shutting down' incident/logs/worker-2026-10-14.jsonl \| cut -d'"' -f4,12,16` | `2026-10-14T14:01:59.032+03:00"shutting down"SIGTERM`<br>`2026-10-14T14:02:07.013+03:00"worker started"1.8.0`<br>`2026-10-14T14:46:59.118+03:00"shutting down"SIGTERM`<br>`2026-10-14T14:47:01.305+03:00"worker started"1.7.3` |
| 4 | v1.8.0 у compose обох сервісів замінює `DB_POOL_MAX` на `DB_POOL_SIZE`, а `DB_POOL_WAIT_MS` лишає 2000 | `grep -n 'DB_POOL' incident/changes/v1.8.0.diff` | `86:-      DB_POOL_MAX: "20"`<br>`87:+      DB_POOL_SIZE: "20"`<br>`88:       DB_POOL_WAIT_MS: "2000"`<br>`106:-      DB_POOL_MAX: "20"`<br>`107:+      DB_POOL_SIZE: "20"`<br>`108:       DB_POOL_WAIT_MS: "2000"` |
| 5 | У стані до релізу (v1.7.3, `main:deploy/compose.yaml`) змінна називається `DB_POOL_MAX` | `git show main:deploy/compose.yaml \| grep -n 'DB_POOL'` | `16:      DB_POOL_MAX: "20"`<br>`17:      DB_POOL_WAIT_MS: "2000"`<br>`30:      DB_POOL_MAX: "20"`<br>`31:      DB_POOL_WAIT_MS: "2000"` |
| 6 | Код читає лише `DB_POOL_MAX`, а без неї бере дефолт 4 | `grep -n 'DB_POOL' app/src/config.js` | `9:    dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,`<br>`10:    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) \|\| 2000,` |
| 7 | Жоден файл в `app/` не читає `DB_POOL_SIZE` | `grep -rl 'DB_POOL_SIZE' app \| grep -c .` | `0` |
| 8 | Реліз не змінював код API (`config.js`, `db.js`, `server.js`, `parcels.js`): лише README, версію, worker, його тест і compose | `grep '^+++ ' incident/changes/v1.8.0.diff` | `+++ b/app/README.md`<br>`+++ b/app/package.json`<br>`+++ b/app/src/worker.js`<br>`+++ b/app/test/worker.test.js`<br>`+++ b/deploy/compose.yaml` |
| 9 | Справжній `loadConfig` з env v1.7.3 дає пул 20, з env v1.8.0 дає 4 | `node -e 'import("./app/src/config.js").then((m) => { const v173 = m.loadConfig({ DB_POOL_MAX: "20", DB_POOL_WAIT_MS: "2000" }); const v180 = m.loadConfig({ DB_POOL_SIZE: "20", DB_POOL_WAIT_MS: "2000" }); console.log("v1.7.3 env -> dbPoolMax", v173.dbPoolMax, "; v1.8.0 env -> dbPoolMax", v180.dbPoolMax); })'` | `v1.7.3 env -> dbPoolMax 20 ; v1.8.0 env -> dbPoolMax 4` |
| 10 | API (і окремо worker) створює пул з `max` = `config.dbPoolMax` | `grep -n 'createPool({' app/src/server.js app/src/worker.js` | `app/src/server.js:91:  const pool = createPool({ max: config.dbPoolMax, waitMs: config.dbPoolWaitMs });`<br>`app/src/worker.js:43:  const pool = createPool({ max: config.dbPoolMax, waitMs: config.dbPoolWaitMs });` |
| 11 | Пул на 4: п'ятий і шостий одночасні запити не отримують з'єднання і падають з `PoolTimeoutError` | `node -e 'import("./app/src/db.js").then(async (m) => { const pool = m.createPool({ max: 4, waitMs: 50 }); const hold = () => pool.withConnection(() => new Promise((r) => setTimeout(r, 200))); const res = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(hold)); console.log(res.map((x) => x.status === "fulfilled" ? "ok" : x.reason.name).join(" ")); })'` | `ok ok ok ok PoolTimeoutError PoolTimeoutError` |
| 12 | Таймаут пулу перетворюється на 503 `service busy, try again` | `grep -n -e 'PoolTimeoutError(waitMs)' -e 'service busy' app/src/db.js app/src/server.js` | `app/src/db.js:77:        reject(new PoolTimeoutError(waitMs));`<br>`app/src/server.js:65:      if (err instanceof PoolTimeoutError) [status, body] = [503, { error: "service busy, try again" }];` |
| 13 | На v1.8.0 (14:02–14:46) `db_pool_in_use` щохвилини дорівнює рівно 4 (45 хвилин з 45) | `awk -F, 'NR>1 && substr($1,12,5)>="14:02" && substr($1,12,5)<"14:47"{print $5}' incident/metrics/2026-10-14.csv \| sort \| uniq -c \| sed 's/^ *//'` | `45 4` |
| 14 | Метрики 14.10, 14:02–14:46: трафік звичайний, черга до 23, p95 до 4962 мс, у середньому 10,7 % 5xx | `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=i=>L.map(r=>+r[i]);const mm=i=>Math.min(...c(i))+".."+Math.max(...c(i));const av=i=>(c(i).reduce((x,y)=>x+y,0)/L.length).toFixed(3);console.log(L.length+" хв; rps avg "+av(1)+"; p95 "+mm(2)+"; error_rate avg "+av(3)+"; in_use "+mm(4)+"; waiting "+mm(5))' incident/metrics/2026-10-14.csv 14:02 14:47` | `45 хв; rps avg 11.802; p95 945..4962; error_rate avg 0.107; in_use 4..4; waiting 4..23` |
| 15 | Baseline 13.10, ті самі 14:02–14:46: такий самий rps, `in_use` 10..13 без черги, p95 ≤ 255 мс | `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=i=>L.map(r=>+r[i]);const mm=i=>Math.min(...c(i))+".."+Math.max(...c(i));const av=i=>(c(i).reduce((x,y)=>x+y,0)/L.length).toFixed(3);console.log(L.length+" хв; rps avg "+av(1)+"; p95 "+mm(2)+"; error_rate avg "+av(3)+"; in_use "+mm(4)+"; waiting "+mm(5))' incident/baseline/metrics-2026-10-13.csv 14:02 14:47` | `45 хв; rps avg 11.849; p95 209..255; error_rate avg 0.002; in_use 10..13; waiting 0..0` |
| 16 | 14.10 перед деплоєм (13:30–14:01, v1.7.3) все так само, як у baseline | `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=i=>L.map(r=>+r[i]);const mm=i=>Math.min(...c(i))+".."+Math.max(...c(i));const av=i=>(c(i).reduce((x,y)=>x+y,0)/L.length).toFixed(3);console.log(L.length+" хв; rps avg "+av(1)+"; p95 "+mm(2)+"; error_rate avg "+av(3)+"; in_use "+mm(4)+"; waiting "+mm(5))' incident/metrics/2026-10-14.csv 13:30 14:02` | `32 хв; rps avg 11.566; p95 208..262; error_rate avg 0.002; in_use 10..13; waiting 0..0` |
| 17 | Після відкату (14:48–14:59) усе як до інциденту | `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=i=>L.map(r=>+r[i]);const mm=i=>Math.min(...c(i))+".."+Math.max(...c(i));const av=i=>(c(i).reduce((x,y)=>x+y,0)/L.length).toFixed(3);console.log(L.length+" хв; rps avg "+av(1)+"; p95 "+mm(2)+"; error_rate avg "+av(3)+"; in_use "+mm(4)+"; waiting "+mm(5))' incident/metrics/2026-10-14.csv 14:48 15:00` | `12 хв; rps avg 11.000; p95 199..296; error_rate avg 0.002; in_use 10..12; waiting 0..0` |
| 18 | Хвилини переходів: деплой (14:02), рестарт (14:20–14:21), відкат (14:47). Колонки: ts, rps, p95, error_rate, in_use, waiting, heap, sms_429 | `grep -e 'T14:0[12]:00' -e 'T14:2[01]:00' -e 'T14:4[67]:00' incident/metrics/2026-10-14.csv` | `2026-10-14T14:01:00+03:00,11.3,245,0.0044,12,0,76,33`<br>`2026-10-14T14:02:00+03:00,11.9,945,0.0042,4,4,42,44`<br>`2026-10-14T14:20:00+03:00,11.1,3270,0.0676,4,6,43,37`<br>`2026-10-14T14:21:00+03:00,11.7,4588,0.1068,4,20,42,36`<br>`2026-10-14T14:46:00+03:00,11.1,4697,0.1186,4,17,65,30`<br>`2026-10-14T14:47:00+03:00,11.5,618,0.0014,14,0,46,40` |
| 19 | Таймаутів пулу 14.10 було 3380, 13.10 жодного | `grep -c 'db pool wait timeout after 2000ms' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` | `incident/logs/api-2026-10-14.jsonl:3380`<br>`incident/baseline/api-2026-10-13.jsonl:0` |
| 20 | Серед 5xx 14.10: 3380 відповідей 503 і 125 відповідей 500. Усі 5xx логуються, тож це повні числа, а інші статуси — вибірка 1 % | `grep -o '"status":[0-9]*' incident/logs/api-2026-10-14.jsonl \| sort \| uniq -c \| sed 's/^ *//'` | `777 "status":200`<br>`200 "status":201`<br>`10 "status":400`<br>`16 "status":403`<br>`140 "status":404`<br>`125 "status":500`<br>`3380 "status":503` |
| 21 | Перший 503 о 14:02:07 (через 7 с після старту 1.8.0), останній о 14:46:58 (за 2 с до старту 1.7.3) | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| cut -c19-30 \| sed -n '1p;$p'` | `14:02:07.172`<br>`14:46:58.204` |
| 22 | 503 зачепили всі маршрути з БД, найбільше `/pickup` | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c \| sed 's/^ *//'` | `144 "path":"/admin/parcels"`<br>`650 "path":"/parcels"`<br>`2586 "path":"/pickup"` |
| 23 | `/pickup` — основний трафік: 823 з 1143 рядків вибірки 1 % (≈72 %), тоді як серед 503 його частка 2586 з 3380 (≈77 %, обчислено з #22) | `grep '"msg":"request"' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c \| sed 's/^ *//'` | `110 "path":"/admin/parcels"`<br>`210 "path":"/parcels"`<br>`823 "path":"/pickup"` |
| 24 | `pickup()` бере з'єднання з пулу тричі поспіль | `sed -n '59,69p' app/src/parcels.js \| grep -c 'pool.withConnection'` | `3` |
| 25 | Кожен 503 чекав щонайменше `DB_POOL_WAIT_MS` = 2000 мс. Найдовший тривав 5607 мс, тобто запит встиг постояти в черзі більше ніж раз | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| sort -n \| sed -n '1p;$p'` | `2000`<br>`5607` |
| 26 | `/health` відповідає 200, не звертаючись до пулу, тому деградацію не бачить | `grep -n '"/health"' app/src/server.js` | `37:    if (method === "GET" && path === "/health") return [200, { status: "ok", version }];`<br>`75:    else if (path !== "/health" && ++seen % ACCESS_LOG_EVERY === 0) log.info("request", fields);` |
| 27 | Текст «Сервіс зайнятий» є лише в описі інциденту і в чаті. У коді `app/` і `deploy/` його немає (`grep -rn 'зайнят' app deploy \| grep -c .` → `0`), отже текст не з API; що його показує термінал — **припущення** | `grep -n 'Сервіс зайнятий' incident/README.md incident/oncall-chat.md` | `incident/README.md:4:посилки: екран поштомата після введення коду показував «Сервіс зайнятий, спробуйте`<br>`incident/oncall-chat.md:9:- **14:08** Олена: взяла. Гаряча лінія: поштомати на Соборній і Шкільній пишуть «Сервіс зайнятий, спробуйте пізніше», люди не можуть забрати посилки.` |
| 28 | Алерти: назва, спрацювання, закриття | `grep -o -e '"name": "[^"]*"' -e '"[a-z]*_at": "[^"]*"' incident/alerts.json \| cut -d'"' -f4 \| sed 's/^2026-10-14T//; s/:00+03:00$//'` | `SmsProvider429RateHigh`<br>`13:37`<br>`15:03`<br>`ApiLatencyP95High`<br>`14:06`<br>`14:48`<br>`Api5xxRateHigh`<br>`14:07`<br>`14:48` |
| 29 | Під час старту API логує лише версію, а фактичний розмір пулу ні | `grep '"service started"' incident/logs/api-2026-10-14.jsonl \| head -1` | `{"ts":"2026-10-14T14:02:00.087+03:00","level":"info","msg":"service started","version":"1.8.0"}` |
| 30 | Дефолт 4 задуманий для локальної розробки, і тест закріплює його як очікувану поведінку при порожньому env | `grep -n 'dbPoolMax, 4' app/test/config.test.js` | `8:  assert.equal(config.dbPoolMax, 4);` (коментар у коді: `grep -n 'sensible default' app/src/config.js` → `8:    // sensible default for local dev`) |
| 31 | Перейменування сховалося в «косметичному» сортуванні змінних | `grep -n 'за алфавітом' incident/changes/v1.8.0.diff` | `73:+# Змінні оточення — за алфавітом.` |
| 32 | У compose v1.7.3 немає healthcheck-а | `git show main:deploy/compose.yaml \| grep -c 'healthcheck'` | `0` |
| 33 | `pickup()` викликає саме термінал поштомата з кодом, який ввела людина | `grep -n 'locker terminal' app/src/parcels.js` | `58:    /** The locker terminal sends the code the person typed; null = no such waiting parcel. */` |
| 34 | `error_rate` рахує всі 5xx; у вікні інциденту це майже лише 503: 3380 з 3432 (98,5 %), решта 52 — фоновий 500 на `trim` (той самий, що й 13.10, «НЕ є причиною», рядок 4) | `awk -F'"' '$4 >= "2026-10-14T14:02" && $4 < "2026-10-14T14:47"' incident/logs/api-2026-10-14.jsonl \| grep '"msg":"request failed"' \| sed -E 's/.*"path":"([^"]*)","status":([0-9]+).*"error":"([^"]*)".*/\2 \1 \3/' \| sort \| uniq -c \| sort -rn \| sed 's/^ *//'` | `2586 503 /pickup db pool wait timeout after 2000ms`<br>`650 503 /parcels db pool wait timeout after 2000ms`<br>`144 503 /admin/parcels db pool wait timeout after 2000ms`<br>`52 500 /parcels Cannot read properties of undefined (reading 'trim')` |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Хто підозрював / чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| 1. SMS-провайдер «душить» нас через 429, і через це все впало | Чат 14:10 («і все через нього»). Обидва прогони AI розглянули й відкинули. Алерт `SmsProvider429RateHigh` спрацював першим, о 13:37 | Стільки ж 429 і в звичайний день: `grep -c '"sms provider rate limited"' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `incident/logs/worker-2026-10-14.jsonl:3065` / `incident/baseline/worker-2026-10-13.jsonl:2935`. Ті самі години 13.10: `grep '"sms provider rate limited"' incident/baseline/worker-2026-10-13.jsonl \| cut -c19-23 \| sed -n '1p;$p'` → `13:24` / `15:01` (14.10: `13:28` / `15:01`). Поріг алерту 13.10 теж перевищувався: `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=L.map(r=>+r[7]);console.log(f.split("/").pop()+": sms_429_per_min "+Math.min(...c)+".."+Math.max(...c)+", хвилин з >20: "+c.filter(x=>x>20).length+" з "+L.length)' incident/baseline/metrics-2026-10-13.csv 13:30 15:00` → `metrics-2026-10-13.csv: sms_429_per_min 14..46, хвилин з >20: 86 з 90` і та сама команда з файлом 14.10: `node -e 'const [f,a,b]=process.argv.slice(1);const L=require("fs").readFileSync(f,"utf8").trim().split("\n").slice(1).map(l=>l.split(",")).filter(r=>r[0].slice(11,16)>=a&&r[0].slice(11,16)<b);const c=L.map(r=>+r[7]);console.log(f.split("/").pop()+": sms_429_per_min "+Math.min(...c)+".."+Math.max(...c)+", хвилин з >20: "+c.filter(x=>x>20).length+" з "+L.length)' incident/metrics/2026-10-14.csv 13:30 15:00` → `2026-10-14.csv: sms_429_per_min 10..45, хвилин з >20: 88 з 90`. Worker — окремий процес (`git show main:deploy/compose.yaml \| grep -n 'command:'` → `25:    command: ["node", "src/worker.js"]`), а SMS він шле поза з'єднанням з БД: `grep -n -e 'withConnection' -e 'sms\.send(' app/src/worker.js` → рядки 24 і 33 (`withConnection`) окремо від рядка 28 (`sms.send(`). 429 не можуть займати пул API. **Але й не шум:** 429 отримує кожен раунд worker-а з понад 10 SMS і жоден з ≤ 10 — поріг рівно на ліміті провайдера 10/с (`materials/vendors/sms-provider.md:16`), бо темп у compose — 20/с (`git show main:deploy/compose.yaml \| grep -n 'SMS_RATE'` → `20:      SMS_RATE_PER_SEC: "20"` / `34:      SMS_RATE_PER_SEC: "20"`). Раунди `[усього, з 429]`: `node -e 'let n=0;const o={"<=10":[0,0],">10":[0,0]};for(const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse)){if(l.msg==="sms provider rate limited")n++;else if(l.msg==="sms batch sent"){const k=o[l.count>10?">10":"<=10"];k[0]++;k[1]+=n>0;n=0}}console.log(JSON.stringify(o))' incident/baseline/worker-2026-10-13.jsonl` → `{"<=10":[805,0],">10":[417,417]}` (14.10: `{"<=10":[814,0],">10":[428,428]}`). Зовнішнє обмеження не вмикалося б рівно на 11-му SMS — це наш власний темп. Окремий хронічний дефект, не причина цього інциденту |
| 2. У провайдера SMS збій: `TLS handshake timeout` о 14:01:37, «ще до деплою» | Чат 14:14 і 14:50. Обидва прогони AI відкинули як поодинокий випадок. Помилка за 23 с до деплою виглядала як «перша ластівка» | Такий самий рядок є й у звичайний день: `grep -c 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `incident/logs/worker-2026-10-14.jsonl:1` / `incident/baseline/worker-2026-10-13.jsonl:1`. Час: `grep 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl \| cut -d'"' -f4` → `2026-10-14T14:01:37.954+03:00` / `2026-10-13T13:12:45.343+03:00`. API з SMS-провайдером не говорить: `grep -c 'sms.example.net' incident/logs/api-2026-10-14.jsonl` → `0`. Усі 503 мають іншу причину (#19). Провайдер підтвердив, що інцидентів немає: `grep -n 'інцидентів немає' incident/oncall-chat.md` → `18:- **14:36** Андрій: провайдер відповів: у них інцидентів немає.` |
| 3. Витік пам'яті в API (heap 81 %, `heap usage high`) | Чат 14:12 і 14:50 («щось із пам'яттю»). Обидва прогони AI відкинули як пилку GC | Попереджень навіть більше в день без інциденту: `grep -c '"heap usage high"' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `incident/logs/api-2026-10-14.jsonl:63` / `incident/baseline/api-2026-10-13.jsonl:70`. Максимум heap однаковий: `awk -F, 'NR>1 && $7>m{m=$7} END{print "max heap_used_pct", m}' incident/baseline/metrics-2026-10-13.csv` → `max heap_used_pct 82` і `awk -F, 'NR>1 && $7>m{m=$7} END{print "max heap_used_pct", m}' incident/metrics/2026-10-14.csv` → `max heap_used_pct 82`. Після деплою heap упав, а латентність зросла, тобто зв'язку немає: `grep -e 'T14:0[1-4]:00' incident/metrics/2026-10-14.csv \| cut -d, -f1,3,7` → `2026-10-14T14:01:00+03:00,245,76` / `2026-10-14T14:02:00+03:00,945,42` / `2026-10-14T14:03:00+03:00,2446,43` / `2026-10-14T14:04:00+03:00,3477,50` (колонки: ts, p95_ms, heap_used_pct) |
| 4. 500 `Cannot read properties of undefined (reading 'trim')` на `POST /parcels` | Обидва прогони AI: «окремий баг», не причина. Це єдина помилка рівня error в API, крім 503 | Частота однакова в обидва дні: `grep -c "reading 'trim'" incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `incident/logs/api-2026-10-14.jsonl:125` / `incident/baseline/api-2026-10-13.jsonl:128`. Це 500 лише на `/parcels`, а не 503 на `/pickup`, отже не «Сервіс зайнятий»: `grep "reading 'trim'" incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*","status":[0-9]*' \| sort \| uniq -c \| sed 's/^ *//'` → `125 "path":"/parcels","status":500`. Джерело — `sender.trim()` без перевірки: `grep -n 'sender.trim' app/src/parcels.js` → `42:      const from = sender.trim();` |
| 5. Зріс трафік (денний пік) | Прогін 1 описує ріст rps «схоже на денний пік». Я сам перевіряв, чи це не перевантаження | rps під час інциденту такий самий, як 13.10 і як до деплою: #14 `rps avg 11.802` проти #15 `rps avg 11.849` і #16 `rps avg 11.566`. Зменшилася пропускна здатність, а не зросло навантаження |
| 6. Гальмує PostgreSQL | Моя власна гіпотеза. Прогін 1 обговорює «повільну БД» і відкидає. Таймаути пулу зазвичай виникають, коли БД повільна | Сама стеля `in_use` = 4 (#13, #14) ці дві гіпотези не розрізняє: на v1.8.0 ліміт пулу був 4, тож і повільна БД показала б рівно 4. Спростовує інше: та сама БД (адреса в релізі не мінялася: `grep -n 'DATABASE_URL' incident/changes/v1.8.0.diff` → `85:       DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat"` / `105:       DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat"`, без `+`/`-`) обслуговувала 10..13 з'єднань з p95 ≤ 262 мс аж до хвилини перед деплоєм (#16, #18: 14:01 → p95 245, `in_use` 12) і з p95 ≤ 296 мс одразу після відкату (#17, #18). Це стрибок рівно в момент деплою й відкату, а не поступове сповільнення БД |
| 7. Витік з'єднань пулу | Альтернатива з прогону 1 (і там відкинута). Пул «закінчився» | Витік наростав би поступово, а `in_use` = 4 вже в першу хвилину після деплою і одразу після рестарту (#18: 14:02 і 14:20 → `4`). Рестарт витік обнулив би, а тут нічого не змінилося. З'єднання повертається у `finally`: `grep -n -e 'finally' -e 'release();' app/src/db.js` → `98:      } finally {` / `99:        release();`. Код пулу реліз не змінював (#8) |
| 8. 1.8.0 «відкриває окремі пули для різних компонентів» або з'єднання тримає щось поза метрикою | Альтернативне пояснення в прогоні 1 (впевненість у механізмі там ~70 %), бо без diff його не можна було виключити | Код API в релізі не змінювався (#8). API створює один пул з `config.dbPoolMax` (#10), а саме `loadConfig` з env v1.8.0 дає рівно 4 (#9). Стеля 4 у метриках збігається з дефолтом, і інших пояснень не потрібно |
| 9. Зміна тексту SMS і повідомлення лога в worker-і (1.8.0) | Автор релізу в чаті 14:13 («причесав конфіг і текст SMS»). Я сам перевіряв, бо це єдина зміна коду в релізі | API не імпортує worker: `grep -c 'worker' app/src/server.js` → `0`. Worker працював як завжди: `grep '"sms batch sent"' incident/logs/worker-2026-10-14.jsonl \| cut -c19-23 \| awk '$1>="14:02" && $1<"14:47"' \| grep -c .` → `211`; `grep '"sms batch sent"' incident/baseline/worker-2026-10-13.jsonl \| cut -c19-23 \| awk '$1>="14:02" && $1<"14:47"' \| grep -c .` → `205` |
| 10. Worker на v1.8.0 теж отримав пул 4 і «з'їв» з'єднання БД | Моя власна гіпотеза: worker отримує ту саму змінну (#4, #10) | Worker — окремий процес з власним пулом у пам'яті процесу (#10, `25:    command: ["node", "src/worker.js"]`), і метрика `db_pool_in_use` рахує пул процесу API (`incident/README.md`, таблиця «Метрики»). Worker тримає не більше одного з'єднання за раз, послідовно (рядки 24/33 у `app/src/worker.js`, див. рядок 1). Пачки SMS ішли в звичному темпі: 211 проти 205 (рядок 9) |
| 11. Тимчасовий збій під час старту нової версії | Прогін 1 перевіряв і відкинув. Деградація почалася одразу після рестарту контейнера | Окремий рестарт о 14:20 на тій самій версії відтворив ту саму картину: у хвилину 14:21 `in_use` 4, `waiting` 20, p95 4588 (#18). 503 тривали до 14:46:58 (#21). Отже, це властивість конфігурації v1.8.0, а не старту |

## Чинники, що сприяли (contributing factors)

- **Тихий дефолт замість помилки старту.** Без `DB_POOL_MAX` `loadConfig` бере 4, дефолт
  «for local dev» (#6, #30). Тест закріплює це як норму. Сервіс не падає й не
  попереджає, що обов'язкову для продакшну змінну не задано.
- **Ефективний розмір пулу ніде не видно.** У `service started` пишеться тільки версія
  (#29), тож за логами не можна було одразу побачити «pool max 4».
- **Небезпечну зміну сховала косметична.** Перейменування змінної потрапило в один diff із
  сортуванням за алфавітом (#31), а реліз назвали «config cleanup» (#1). Автор щиро вважав,
  що в ньому «нічого суттєвого» (`incident/oncall-chat.md:12`). Перевірки «кожна змінна з
  compose справді читається в `config.js`» немає: назву `DB_POOL_SIZE` у `app/` не читає
  ніхто (#7).
- **`/health` не перевіряє пул** (#26) і завжди відповідав 200
  (`incident/oncall-chat.md:17`). У compose немає healthcheck-а (#32), тож автоматика
  деградацію не помітила б.
- **Немає алерту на насичення пулу.** Алертів лише три, і жоден не стежить за
  `db_pool_waiting` (#28). Черга з'явилася о 14:02 (#18), а перший пейдж прийшов о 14:06.
- **Звичний алерт відвів увагу.** `SmsProvider429RateHigh` спрацьовує і в звичайний день
  (86 з 90 хвилин понад поріг 13.10, «НЕ є причиною», рядок 1). Він не хибний: 429 щодня
  спричиняє наш власний темп 20/с при ліміті 10/с. Але цей дефект давно став фоном, тож
  алерт не відрізняв «як завжди» від «щось нове». Плюс одиничний TLS-таймаут і пилка heap.
  Розслідування пішло хибними слідами (чат 14:10–14:17).
- **Першою дією став рестарт, а не відкат.** Деплой був за 4 хв до пейджа (#1, #28), але
  спершу перезапустили API на тій самій версії, що не могло допомогти (#18). Відкат стався
  через 45 хв після деплою і «на всяк випадок» (#1).
- **Вузький пул ударив по основній операції.** Більшість відповідей 503 припала на
  `/pickup` головно тому, що це ≈72 % трафіку (#23). Три послідовні звернення до пулу (#24)
  додають лише кілька відсоткових пунктів: ≈77 % серед відповідей 503 проти ≈72 % трафіку
  (#22, #23). Саме ця операція й ламала видачу посилок.

## Впевненість

**Висока.** Ланцюжок підтверджено з трьох незалежних боків:
(1) конфігурація: перейменування в diff (#4) плюс код, що читає лише стару назву з дефолтом
4 (#6, #7), відтворено справжнім `loadConfig` (#9);
(2) метрики: стеля рівно 4 всі 45 хв (#13), повний збіг меж з деплоєм і відкатом до секунд
(#1, #2, #21) за незмінного трафіку (#14–#17);
(3) логи: усі 3380 відповідей 503 — це таймаут пулу 2000 мс, якого 13.10 немає зовсім (#19).
Усі конкурентні гіпотези спростовано порівнянням з baseline (розділ вище).

**Чого бракує:**
- фактичного оточення контейнера в проді (`docker inspect` / env процесу) і самого
  `compose.yaml` з VM на момент інциденту. Зміну видно лише в `incident/changes/v1.8.0.diff`,
  а `main:deploy/compose.yaml` — це стан v1.7.3 (#5);
- прямого доказу, що відкат повернув і compose, а не лише образ. Є тільки непрямий: `in_use`
  14 > 4 одразу після відкату (#18);
- коду термінала поштомата: що 503 `service busy` він показує як «Сервіс зайнятий»
  — **припущення** (#27);
- джерела метрики `db_pool_in_use`. Те, що це `pool.stats().inUse` процесу API, —
  **припущення** на основі опису в `incident/README.md`.

**Що могло б змінити висновок:** якби в проді був override-файл або `.env` із
`DB_POOL_MAX`, тобто фактичний пул не дорівнював 4. Тоді стелю 4 треба було б пояснити
інакше. Але жодне інше джерело в даних не дає саме числа 4, і стеля зникла саме з відкатом
конфігурації (#18).

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | «У релізі 1.8.0 змінилася робота з пулом БД: його ліміт фактично знизився до 4 з'єднань, хоча під піком треба 10–14». Звідки ліміт 4, не пояснює: «диффу 1.8.0, конфігів і changelog у теці немає» | «у релізі v1.8.0 („config cleanup“, #212) в `deploy/compose.yaml` змінну `DB_POOL_MAX: "20"` перейменували на `DB_POOL_SIZE: "20"`. Код цю нову назву не читає». API «тихо запустився з пулом на **4 з'єднання** замість 20» |
| Впевненість, яку заявив AI | «Що інцидент спричинив реліз 1.8.0: висока, ~90 %»; «Що механізм саме в ліміті пулу 4 з'єднання: середня, ~70 %» | «Впевненість: висока, ~95 %» |
| Збігається з вашою? | частково: реліз і механізм (стеля пулу 4 → черга → 503) правильні, але справжньої причини стелі (перейменування змінної + дефолт 4) немає. Механізм лишається одним із кількох варіантів («окремі пули», «щось поза метрикою»), які я спростував («НЕ є причиною», рядок 8) | так: той самий ланцюжок, усі ланки я перевірив сам (#4–#13, #18) |
| Що в даних вплинуло на відповідь | — | `incident/changes/v1.8.0.diff` (перейменування, #4) разом з `app/src/config.js:9` (дефолт 4, #6) пояснили, звідки саме 4. `deploys.log` дав точні межі й те, що рестарт був на тій самій версії (#1). Baseline 13.10 дав кількісне спростування 429, heap, TLS і trim. `oncall-chat.md` показав хибні сліди, які прогін 2 розібрав окремо |

Неточності прогонів, які я не переношу в RCA. Прогін 1 пише, що «worker має лише 2 спроби з
малим backoff (400/800 мс)». У коді спроб 4 (`grep -n 'maxAttempts = ' app/src/sms.js` →
`14:  maxAttempts = 4,`), а в логах просто не трапилося затримки довшої за 800 мс
(`grep -o '"retry_in_ms":[0-9]*' incident/logs/worker-2026-10-14.jsonl | sort | uniq -c | sed 's/^ *//'`
→ `1730 "retry_in_ms":400` / `1335 "retry_in_ms":800`). Прогін 2 пояснює перевагу `/pickup`
серед 503 тим, що він бере з'єднання тричі (#24). Але частка `/pickup` серед 503 (≈77 %, #22)
лише трохи більша за його частку трафіку (≈72 %, #23), тож головна причина — обсяг трафіку.

**Число:** прогін 1 назвав першопричиною «У релізі 1.8.0 змінилася робота з пулом БД: його ліміт фактично знизився до 4 з'єднань»
з упевненістю ~90 % щодо релізу і ~70 % щодо механізму. З моїм RCA це збігається частково:
є реліз і стеля 4, але немає причини стелі. Прогін 2 назвав перейменування `DB_POOL_MAX` →
`DB_POOL_SIZE` у compose v1.8.0, через яке спрацював дефолт `|| 4` у `config.js:9`, з
упевненістю «висока, ~95 %». Це повністю збігається з моїм RCA. Відповідь змінили
додаткові дані: diff релізу разом з `app/src/config.js` перетворили «число 4 у метриках»
на доведений механізм. `deploys.log` і baseline 13.10 дали змогу кількісно відкинути
хибні сліди.
