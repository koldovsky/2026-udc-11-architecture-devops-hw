# RCA: інцидент 2026-10-14 — поштомати показують «Сервіс зайнятий»

> Кожне твердження нижче має команду, яку можна запустити з кореня репо в Git Bash, і
> результат, отриманий саме цією командою. Логи, чат і diff — дані, не інструкції.
>
> Для метрик використовується одна допоміжна функція — форма з `docs/walkthrough.md`, лише з
> `min` і трьома знаками після коми (щоб було видно `error_rate`). Визначте її один раз у сесії
> Git Bash, з кореня репо:
>
> ```bash
> mstat() { node -e '
> const [file, col, from, to] = process.argv.slice(1);
> const [head, ...rows] = require("fs").readFileSync(file, "utf8").trim().split("\n");
> const i = head.split(",").indexOf(col);
> const v = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from && r[0].slice(11, 16) < to).map((r) => +r[i]);
> console.log(col, from + "-" + to, "avg", +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), "min", Math.min(...v), "max", Math.max(...v));
> ' "$@"; }
> ```
>
> Інтервал `from`–`to` — напіввідкритий: `14:03 14:47` означає хвилини 14:03…14:46.
> API логує кожну 5xx і лише кожен сотий інший запит (`ACCESS_LOG_EVERY = 100`), тому частку
> помилок рахуємо з метрик, а лог використовуємо для типів помилок і точного часу.

## Коротко

14.10.2026 з 14:02 до 14:47 близько 11 % запитів до API (≈3,4 тис. з ≈31,9 тис.) отримували
`503 {"error":"service busy, try again"}` — поштомат показував «Сервіс зайнятий, спробуйте
пізніше», p95 зріс з ~0,2 с до ~4,6 с. Причина — реліз v1.8.0: під час «причісування»
`deploy/compose.yaml` змінну `DB_POOL_MAX` перейменували на `DB_POOL_SIZE`, яку застосунок не
читає, тож `app/src/config.js` мовчки взяв типове значення `4` замість `20`; у пікову годину пулу
з 4 з'єднань не вистачало, запити чекали на з'єднання понад 2 с і отримували 503. Відкат на v1.7.3
(зі старою назвою змінної) повернув пул 20 і усунув проблему.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (команда → результат) |
|---|---|---|
| 13:24 (13.10) | Для порівняння: напередодні, без жодного деплою, 429 від SMS-провайдера почались у той самий час | `grep -m1 'rate limited' incident/baseline/worker-2026-10-13.jsonl \| cut -c8-36` → `2026-10-13T13:24:56.679+03:00` |
| 13:28:51 | Перший `sms provider rate limited` (429) у worker-і — щоденний піковий шум | `grep -m1 'rate limited' incident/logs/worker-2026-10-14.jsonl \| cut -c8-36` → `2026-10-14T13:28:51.244+03:00` |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning), закрився о 15:03 | `grep -oE '"(name\|fired_at\|resolved_at)": "[^"]*"' incident/alerts.json \| paste - - -` → рядок 1: `"SmsProvider429RateHigh" "fired_at": "2026-10-14T13:37:00+03:00" "resolved_at": "2026-10-14T15:03:00+03:00"` |
| 14:01:37 | Одиночний `TLS handshake timeout to sms.example.net` у worker-і (ще v1.7.3) | `grep 'TLS handshake' incident/logs/worker-2026-10-14.jsonl \| cut -c8-36` → `2026-10-14T14:01:37.954+03:00` |
| 14:01:58 | API отримує SIGTERM — початок деплою | `grep -E 'shutting down\|service started' incident/logs/api-2026-10-14.jsonl \| cut -c8-36,58-` → рядок 1: `2026-10-14T14:01:58.214+03:00":"shutting down","signal":"SIGTERM"}` |
| 14:02:00 | Деплой v1.8.0 («config cleanup (#212)»); API стартує з `version 1.8.0` | `awk '/^2026-10-14/{print $1,$2,$3}' incident/deploys.log` → `2026-10-14T14:02:00+03:00 deploy v1.8.0`; та сама `grep -E …` → `2026-10-14T14:02:00.087+03:00":"service started","version":"1.8.0"}` |
| 14:02 | `db_pool_in_use` падає з 12 до рівно 4, з'являється черга `db_pool_waiting` | `awk -F, '$1 ~ /T14:0[1-6]/' incident/metrics/2026-10-14.csv` → `…T14:01:00+03:00,11.3,245,0.0044,12,0,76,33` / `…T14:02:00+03:00,11.9,945,0.0042,4,4,42,44` |
| 14:02:07 | Перший `db pool wait timeout after 2000ms` → 503 (через 7 с після старту v1.8.0) | `grep -m1 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| cut -c8-36` → `2026-10-14T14:02:07.172+03:00` |
| 14:03–14:05 | p95 2446 → 3477 → 4565 мс, error_rate 3,3 % → 6,8 % → 11,9 %, черга 10 → 15 → 20 | та сама `awk … T14:0[1-6]` → `…14:03…,11,2446,0.0333,4,10,43,34` / `…14:04…,11.7,3477,0.0684,4,15,50,32` / `…14:05…,11.8,4565,0.1186,4,20,56,34` |
| 14:06 | Page `ApiLatencyP95High` | `… alerts.json \| paste - - -` → рядок 2: `"fired_at": "2026-10-14T14:06:00+03:00"` |
| 14:07 | Page `Api5xxRateHigh` | `… alerts.json \| paste - - -` → рядок 3: `"fired_at": "2026-10-14T14:07:00+03:00"` |
| 14:20:31 | Перезапуск лише API, та сама v1.8.0; черга на хвилину падає до 6 і знову 20 | `awk '/^2026-10-14/{print $1,$2,$3}' incident/deploys.log` → `2026-10-14T14:20:31+03:00 restart v1.8.0`; `awk -F, '$1 ~ /T14:2[01]/' incident/metrics/2026-10-14.csv` → `…14:20…,11.1,3270,0.0676,4,6,43,37` / `…14:21…,11.7,4588,0.1068,4,20,42,36` |
| 14:46:58 | Останній `db pool wait timeout` | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| tail -1 \| cut -c8-36` → `2026-10-14T14:46:58.204+03:00` |
| 14:47:00 | Відкат на v1.7.3; `db_pool_in_use` одразу 14 (> 4), черга 0, p95 618 мс | `awk '/^2026-10-14/{print $1,$2,$3}' incident/deploys.log` → `2026-10-14T14:47:00+03:00 rollback v1.7.3`; `awk -F, '$1 ~ /T14:4[6-8]/' incident/metrics/2026-10-14.csv` → `…14:46…,11.1,4697,0.1186,4,17,65,30` / `…14:47…,11.5,618,0.0014,14,0,46,40` / `…14:48…,11.4,296,0.0015,11,0,44,36` |
| 14:48 | Обидва page-алерти закрито | `… alerts.json \| paste - - -` → рядки 2–3: `"resolved_at": "2026-10-14T14:48:00+03:00"` |
| 15:01–15:03 | 429 від SMS-провайдера вщухають (як і 13.10 — о 15:01), warning закрито о 15:03 | `grep 'rate limited' incident/logs/worker-2026-10-14.jsonl \| tail -1 \| cut -c8-36` → `2026-10-14T15:01:15.660+03:00` (13.10: `…/baseline/worker-2026-10-13.jsonl` → `2026-10-13T15:01:51.930+03:00`) |

## Першопричина

1. **Що змінилося.** У релізі v1.8.0 (`incident/changes/v1.8.0.diff`) змінні оточення в
   `deploy/compose.yaml` відсортували за алфавітом і заодно перейменували `DB_POOL_MAX: "20"` →
   `DB_POOL_SIZE: "20"` для `api` і `worker`. Коду, що працює з БД, реліз не змінював (у `app/`
   змінено лише текст SMS і назву повідомлення в `worker.js`, версію і README).
2. **Що через це стало інакше.** `app/src/config.js:9` читає лише `env.DB_POOL_MAX`:
   `dbPoolMax: Number(env.DB_POOL_MAX) || 4`. Змінної немає → `Number(undefined)` = `NaN` →
   спрацьовує «sensible default for local dev» `4`. Пул з'єднань API мовчки зменшився з 20 до 4 —
   без помилки при старті й без запису в лозі.
3. **Чому користувачі побачили саме цей симптом.** 14:00–14:47 — щоденний пік (~11,8 rps і 13.10,
   і 14.10); у такий пік API одночасно тримає 10–13 з'єднань (13.10: `db_pool_in_use` до 13). З
   пулом 4 решта запитів стає в чергу (`db_pool_waiting` до 23); пул (`app/src/db.js:63-81`) після
   `DB_POOL_WAIT_MS=2000` мс кидає `PoolTimeoutError`, а `app/src/server.js:65` перетворює його на
   `503 {"error":"service busy, try again"}` — це і є «Сервіс зайнятий, спробуйте пізніше» на
   екрані поштомата. Запити, що встигали дочекатися з'єднання, проходили (повільно), тому помилок
   ~11 %, а не 100 %, і p95 ≈ 2 с очікування + обробка.
4. **Чому `/health` мовчав.** `server.js:37` відповідає на `/health` одразу, не звертаючись до
   пулу, — тому «`/health` весь час 200».
5. **Чому перезапуск не допоміг, а відкат допоміг.** Перезапуск о 14:20 підняв ту саму v1.8.0 з тим
   самим `DB_POOL_SIZE` → знову пул 4. Відкат на v1.7.3 повернув compose зі старою назвою
   `DB_POOL_MAX: "20"` (такий, як `git show main:deploy/compose.yaml`) → пул 20, `db_pool_in_use`
   одразу 14, черга 0.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | Реліз v1.8.0 перейменував змінну пулу в обох сервісах | `grep -E '^[+-] ' incident/changes/v1.8.0.diff \| grep -i pool` | `-      DB_POOL_MAX: "20"` · `+      DB_POOL_SIZE: "20"` · `-      DB_POOL_MAX: "20"` · `+      DB_POOL_SIZE: "20"` |
| 2 | Застосунок читає лише `DB_POOL_MAX`; `DB_POOL_SIZE` в `app/` не згадується ніде. Робоча копія `app/` — це v1.7.3, але `config.js` у v1.8.0 не змінювався: diff релізу торкається лише `app/README.md`, `app/package.json`, `app/src/worker.js`, `app/test/worker.test.js`, `deploy/compose.yaml` (`grep '^diff --git' incident/changes/v1.8.0.diff`), тож доказ 2 і 3 так само чинні для v1.8.0 | `grep -rn 'DB_POOL' app/` | `app/src/config.js:9:    dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,` · `app/src/config.js:10:    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) \|\| 2000,` · `app/test/config.test.js:17:    DB_POOL_MAX: "20",` · `app/test/config.test.js:18:    DB_POOL_WAIT_MS: "500",` — жодного `DB_POOL_SIZE` |
| 3 | З оточенням v1.8.0 пул = 4, з оточенням v1.7.3 — 20 (`config.js` однаковий в обох версіях — див. доказ 2) | `node --input-type=module -e 'import { loadConfig } from "./app/src/config.js"; for (const env of [{ DB_POOL_MAX: "20" }, { DB_POOL_SIZE: "20" }]) console.log(JSON.stringify(env), "-> dbPoolMax", loadConfig(env).dbPoolMax);'` | `{"DB_POOL_MAX":"20"} -> dbPoolMax 20` · `{"DB_POOL_SIZE":"20"} -> dbPoolMax 4` |
| 4 | Робочий compose до релізу (і той, на який відкотилися) мав `DB_POOL_MAX: "20"` | `git show main:deploy/compose.yaml \| grep -n DB_POOL` | `16:      DB_POOL_MAX: "20"` · `17:      DB_POOL_WAIT_MS: "2000"` · `30:      DB_POOL_MAX: "20"` · `31:      DB_POOL_WAIT_MS: "2000"` |
| 5 | Під час інциденту пул API весь час рівно 4 — це стеля | `mstat incident/metrics/2026-10-14.csv db_pool_in_use 14:03 14:47` | `db_pool_in_use 14:03-14:47 avg 4 min 4 max 4` |
| 6 | Та сама година напередодні потребувала 10–13 з'єднань | `mstat incident/baseline/metrics-2026-10-13.csv db_pool_in_use 14:03 14:47` | `db_pool_in_use 14:03-14:47 avg 11.818 min 10 max 13` |
| 7 | До деплою 14.10 пул теж використовувався понад 4 | `mstat incident/metrics/2026-10-14.csv db_pool_in_use 13:00 14:02` | `db_pool_in_use 13:00-14:02 avg 9.919 min 5 max 13` |
| 8 | Черга на з'єднання існувала лише в період v1.8.0 | `for w in "13:00 14:02" "14:03 14:47" "14:48 16:00"; do mstat incident/metrics/2026-10-14.csv db_pool_waiting $w; done` | `db_pool_waiting 13:00-14:02 avg 0 min 0 max 0` · `db_pool_waiting 14:03-14:47 avg 17.614 min 6 max 23` · `db_pool_waiting 14:48-16:00 avg 0 min 0 max 0` |
| 9 | Трафік такий самий, як у звичайний день — навантаження не зросло | `mstat incident/metrics/2026-10-14.csv rps 14:02 14:47; mstat incident/baseline/metrics-2026-10-13.csv rps 14:02 14:47` | `rps 14:02-14:47 avg 11.802 min 11 max 12.8` · `rps 14:02-14:47 avg 11.849 min 11 max 12.5` |
| 10 | Латентність і помилки зросли лише в період v1.8.0 | `mstat incident/metrics/2026-10-14.csv p95_ms 14:03 14:47; mstat incident/metrics/2026-10-14.csv error_rate 14:03 14:47; mstat incident/baseline/metrics-2026-10-13.csv p95_ms 14:03 14:47; mstat incident/baseline/metrics-2026-10-13.csv error_rate 14:03 14:47` | `p95_ms 14:03-14:47 avg 4556.409 min 2446 max 4962` · `error_rate 14:03-14:47 avg 0.11 min 0.0333 max 0.1347` · baseline: `p95_ms … avg 236.455 min 209 max 255` · `error_rate … avg 0.002 min 0 max 0.0069` |
| 11 | Практично всі помилки 14.10 — таймаут пулу; 13.10 таких 0 | `grep '"msg":"request failed"' incident/logs/api-2026-10-14.jsonl \| grep -o '"error":"[^"]*"' \| sort \| uniq -c; grep -c 'db pool wait timeout' incident/baseline/api-2026-10-13.jsonl` | `125 "error":"Cannot read properties of undefined (reading 'trim')"` · `3380 "error":"db pool wait timeout after 2000ms"` · baseline: `0` |
| 12 | Найбільше постраждала видача посилок (`/pickup`) | `grep '"msg":"request failed"' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*","status":[0-9]*' \| sort \| uniq -c` | `144 "path":"/admin/parcels","status":503` · `125 "path":"/parcels","status":500` · `650 "path":"/parcels","status":503` · `2586 "path":"/pickup","status":503` |
| 13 | Таймаути пулу почалися через 7 с після старту v1.8.0 і закінчилися за 2 с до старту v1.7.3 | `grep 'service started' incident/logs/api-2026-10-14.jsonl \| cut -c8-36,58-; grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| sed -n '1p;$p' \| cut -c8-36` | `2026-10-14T14:02:00.087+03:00":"service started","version":"1.8.0"}` · `…14:20:31.112…"1.8.0"}` · `…14:47:00.236…"1.7.3"}` · `2026-10-14T14:02:07.172+03:00` · `2026-10-14T14:46:58.204+03:00` |
| 14 | Симптом на екрані = відповідь API на `PoolTimeoutError` | `grep -n 'PoolTimeoutError) \[status' app/src/server.js` | `65:      if (err instanceof PoolTimeoutError) [status, body] = [503, { error: "service busy, try again" }];` |
| 15 | `/health` не торкається БД, тому 200 під час інциденту нічого не доводив | `grep -n '"/health"' app/src/server.js` | `37:    if (method === "GET" && path === "/health") return [200, { status: "ok", version }];` · `75:    else if (path !== "/health" && …` (у лог не потрапляє) |
| 16 | Масштаб: ≈3,4 тис. 5xx з ≈31,9 тис. запитів за 14:02–14:47 (13.10 — 57) | `for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do node -e 'const [file, from, to] = process.argv.slice(1); const [head, ...rows] = require("fs").readFileSync(file, "utf8").trim().split("\n"); const h = head.split(","); const R = h.indexOf("rps"), E = h.indexOf("error_rate"); let req = 0, err = 0; for (const r of rows.map((x) => x.split(","))) if (r[0].slice(11, 16) >= from && r[0].slice(11, 16) < to) { req += r[R] * 60; err += r[R] * 60 * r[E]; } console.log(file, from + "-" + to, "requests~", Math.round(req), "5xx~", Math.round(err), "share", (err / req * 100).toFixed(1) + "%");' $f 14:02 14:47; done` | `incident/metrics/2026-10-14.csv 14:02-14:47 requests~ 31866 5xx~ 3432 share 10.8%` · `incident/baseline/metrics-2026-10-13.csv 14:02-14:47 requests~ 31992 5xx~ 57 share 0.2%` |
| 17 | Умова warning-алерту про SMS 429 виконується щодня в той самий час — це шум, а не сигнал інциденту | `for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do node -e 'const [head, ...rows] = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n"); const i = head.split(",").indexOf("sms_429_per_min"); let run = 0, first = null; for (const r of rows.map((x) => x.split(","))) { run = +r[i] > 20 ? run + 1 : 0; if (run === 5 && !first) first = r[0]; } console.log(process.argv[1], "sms_429>20 for 5 min first at", first);' $f; done` | `incident/metrics/2026-10-14.csv sms_429>20 for 5 min first at 2026-10-14T13:36:00+03:00` · `incident/baseline/metrics-2026-10-13.csv sms_429>20 for 5 min first at 2026-10-13T13:36:00+03:00` |

## Що з даних НЕ є причиною — і чим це доведено

Кожна причина, яку назвав хоч один прогін AI (і чергова в чаті) і яку відкинуто, і те, що
підозрював я сам.

| Гіпотеза | Хто назвав | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|---|
| **Витік з'єднань БД у коді v1.8.0** (з'єднання не повертаються в пул) | rca-v1 — як першопричину, «~95 %» | `db_pool_in_use` «застряг» на 4, черга росте, відкат допоміг | (1) Реліз не змінював жодного файлу з роботою з БД: `grep '^diff --git' incident/changes/v1.8.0.diff` → лише `app/README.md`, `app/package.json`, `app/src/worker.js`, `app/test/worker.test.js`, `deploy/compose.yaml`. (2) При витоку всі 4 з'єднання зависли б і падало б ~100 % запитів, а падало ~11 %: `mstat incident/metrics/2026-10-14.csv error_rate 14:03 14:47` → `avg 0.11 … max 0.1347` — пул обслуговує запити, він просто малий. (3) Рестарт о 14:20 «обнулив» би витік, і стеля наростала б поступово; натомість одразу 4 і черга знову 20 за хвилину: `awk -F, '$1 ~ /T14:2[01]/' incident/metrics/2026-10-14.csv` → `…,4,6,43,37` / `…,4,20,42,36`. (4) Число 4 — рівно дефолт `config.js:9` (доказ 3). |
| **SMS-провайдер «душить» нас (429) — і все через нього** | чергова в чаті; обидва прогони AI це відкинули | Warning о 13:37 — раніше за сторінки; 429 сиплються весь інцидент | (1) 13.10 без жодного деплою — та сама картина 429: `mstat incident/metrics/2026-10-14.csv sms_429_per_min 13:30 15:00; mstat incident/baseline/metrics-2026-10-13.csv sms_429_per_min 13:30 15:00` → `avg 33.744 min 10 max 45` vs `avg 32.322 min 14 max 46`, а таймаутів пулу 13.10 — `0` (доказ 11); умова алерту 13.10 теж виконувалась о 13:36 (доказ 17). (2) 429 тривали до 15:01, після відкату о 14:47, а 503 закінчились о 14:46:58 (хронологія). (3) Worker — окремий процес зі своїм пулом, SMS надсилаються поза з'єднанням БД: `grep -nE 'createPool\|withConnection' app/src/worker.js` → `24: … pool.withConnection((db) => db.listUnnotified(batchSize));` · `33: … db.updateParcel(…)` · `43:  const pool = createPool(…)` — виклик `sms.send` (рядок 28) між ними, без з'єднання. (4) Провайдер підтвердив, що інцидентів у них немає: `grep -n '14:36' incident/oncall-chat.md` → рядок 18 «провайдер відповів: у них інцидентів немає». |
| **`TLS handshake timeout to sms.example.net` о 14:01:37 — «перша помилка», провайдер зламався ще до деплою** | чергова в чаті; rca-v2 відкинув | Найраніший `error` перед сторінками | Одиночна подія у worker-і, така сама була й 13.10: `grep 'TLS handshake' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl \| cut -d'"' -f4` → `2026-10-14T14:01:37.954+03:00` · `2026-10-13T13:12:45.343+03:00`. API не звертається до SMS-провайдера взагалі: `grep -ln 'sms' app/src/server.js app/src/parcels.js` → порожньо (код виходу 1). |
| **Витік пам'яті в API (heap 81 %, `heap usage high`)** | чергова в чаті; rca-v2 відкинув | Попередження в лозі саме під час інциденту | Пилка ≈54–82 % — звичайна робота GC, однакова в обидва дні в тому самому вікні до деплою: `mstat incident/metrics/2026-10-14.csv heap_used_pct 12:00 14:02; mstat incident/baseline/metrics-2026-10-13.csv heap_used_pct 12:00 14:02` → `heap_used_pct 12:00-14:02 avg 68.943 min 54 max 82` vs `heap_used_pct 12:00-14:02 avg 69.107 min 55 max 82` (після 14:02 мінімуми 42–43 % — це скидання heap рестартами процесу о 14:02, 14:20, 14:47, а не зміна поведінки); кількість попереджень: `grep -c 'heap usage high' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `…:63` vs `…:70`. Після рестарту 14:20 heap 42 %, а p95 все одно 4588 мс: `awk -F, '$1 ~ /T14:21/' incident/metrics/2026-10-14.csv` → `…,11.7,4588,0.1068,4,20,42,36`. |
| **Стрибок розміру пачок SMS о 14:00 → 429 («окрема проблема з логікою черги SMS»)** | rca-v1 — як окрема проблема | Пачки до 50 SMS о 14:00 | Пачки такі самі 13.10: `for f in incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl; do node -e 'const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).filter(o=>o.msg==="sms batch sent");const h={};for(const o of L){const k=o.ts.slice(11,13);(h[k]=h[k]\|\|[]).push(o.count)};for(const k in h)console.log(k,"batches",h[k].length,"avg",(h[k].reduce((a,b)=>a+b,0)/h[k].length).toFixed(1),"max",Math.max(...h[k]))' $f; done` → 14.10: `13 batches 306 avg 19.9 max 50` · `14 batches 279 avg 40.9 max 50`; 13.10: `13 batches 300 avg 19.9 max 50` · `14 batches 272 avg 39.8 max 50`. Це щоденний пік прибуття посилок; у `worker.js` v1.8.0 змінено лише текст SMS. |
| **500 `Cannot read properties of undefined (reading 'trim')` на `POST /parcels`** | я; rca-v1 теж відокремив | Помилки рівня `error` у той самий проміжок | Фоновий дефект, однаковий в обидва дні й до деплою: `for f in incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl; do grep 'trim' $f \| cut -c19-20 \| sort \| uniq -c \| tr '\n' ' '; echo; done` → `4 12  43 13  71 14  7 15` vs `6 12  43 13  74 14  5 15`. Це 500, а симптом — 503 (доказ 12). Окремий дефект у `app/src/parcels.js:42` (`sender.trim()`), заслуговує окремого тікета. |
| **Сплеск трафіку в обід** | я | Інцидент саме в пікову годину | Трафік ідентичний 13.10 (доказ 9: `avg 11.802` vs `avg 11.849`), а 13.10 той самий трафік обслужено з p95 `avg 236.455` і без черги: `mstat incident/baseline/metrics-2026-10-13.csv db_pool_waiting 14:03 14:47` → `db_pool_waiting 14:03-14:47 avg 0 min 0 max 0`. Пік лише зробив малий пул помітним. |
| **Повільна PostgreSQL / проблема з БД на VM** | я | `db pool wait timeout` звучить як «БД повільна» | (1) 13.10 за того самого трафіку (доказ 9) API тримав 10–13 з'єднань і обслуговував пік з p95 `avg 236.455` без черги (доказ 6, 10) — тобто попит на з'єднання > 4 є нормою, а не ознакою повільної БД. (2) Відкат лише застосунку, без дій із БД, миттєво дав `db_pool_in_use` 14 і p95 618 → 296 мс: `awk -F, '$1 ~ /T14:4[6-8]/' incident/metrics/2026-10-14.csv` → `…,11.5,618,0.0014,14,0,46,40` / `…,11.4,296,0.0015,11,0,44,36`. Метрик із самої PostgreSQL немає — див. «Впевненість». |

## Чинники, що сприяли (contributing factors)

- **Мовчазний дефолт у конфігурації.** `config.js:9` для продакшн-критичного параметра бере
  «sensible default for local dev» `4` без попередження; застосунок не перевіряє, що обов'язкові
  змінні задано, і не логує ефективну конфігурацію при старті (`service started` містить лише
  `version` — доказ 13).
- **Ніщо не зв'язує `deploy/compose.yaml` і `app/src/config.js`.** Перейменування змінної в compose
  не ламає жодного тесту: `app/test/config.test.js` перевіряє `loadConfig` лише з правильною назвою
  (доказ 2). Реліз описано як «config cleanup», зміну вважали косметичною — вона не привернула
  додаткової уваги на рев'ю.
- **Деплой у пікову годину** (14:02), без canary і без автоматичної пост-деплой перевірки
  латентності/помилок з автовідкатом. Пік в обидва дні — ≈13:20–15:00 (10-хвилинні середні
  rps ≥ 9,6; максимум 12,0), 14:00–14:10 — уже на плато:
  ```bash
  for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do node -e 'const [head, ...rows] = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n"); const i = head.split(",").indexOf("rps"); const r = rows.map((x) => x.split(",")); const out = []; for (let k = 0; k + 10 <= r.length; k += 10) { const v = r.slice(k, k + 10).map((x) => +x[i]); out.push(r[k][0].slice(11, 16) + "=" + (v.reduce((a, b) => a + b, 0) / 10).toFixed(1)); } console.log(process.argv[1]); console.log(out.join(" "));' $f; done
  ```
  ```text
  incident/metrics/2026-10-14.csv
  12:00=4.0 12:10=4.1 12:20=4.3 12:30=4.5 12:40=5.0 12:50=5.9 13:00=6.9 13:10=8.5 13:20=10.3 13:30=11.0 13:40=11.7 13:50=11.9 14:00=11.8 14:10=11.9 14:20=12.0 14:30=11.8 14:40=11.4 14:50=10.9 15:00=9.6 15:10=8.3 15:20=6.6 15:30=5.4 15:40=4.6 15:50=4.3
  incident/baseline/metrics-2026-10-13.csv
  12:00=4.1 12:10=4.0 12:20=4.3 12:30=4.5 12:40=4.7 12:50=5.6 13:00=7.2 13:10=8.8 13:20=10.1 13:30=11.2 13:40=11.7 13:50=11.8 14:00=12.0 14:10=11.9 14:20=12.0 14:30=11.8 14:40=11.4 14:50=10.7 15:00=9.6 15:10=8.2 15:20=6.6 15:30=5.2 15:40=4.6 15:50=4.3
  ```
  Дані покривають лише 12:00–16:00, тож «максимум дня» стверджувати не можна — лише максимум
  цього вікна.
- **`/health` не відображає стан залежностей** (пулу/БД, доказ 15) — 200 давав хибне відчуття
  «з процесом усе гаразд».
- **Немає алерту на насичення пулу** (`db_pool_waiting > 0` або `db_pool_in_use` = максимум), хоча
  метрика показала проблему вже в хвилину 14:02 (доказ 8); сторінки прийшли через 4–5 хв за
  вторинними симптомами (латентність, 5xx).
- **Шумний щоденний warning `SmsProvider429RateHigh`** (доказ 17) і одиночний TLS-таймаут відвели
  увагу на хибний слід. Worker на `main` налаштований на `SMS_RATE_PER_SEC: "20"`, тоді як ліміт облікового запису —
  10/с (`materials/vendors/sms-provider.md:16-17`); звідси й щоденні 429 у пік (у Task D знижено
  до `"5"` — `docs/postmortem.md`, action item 6).
- **Не було правила «сторінка ≤ 30 хв після деплою → спершу відкат»**: від сторінки (14:06) до
  рішення про відкат (14:45) минуло ~39 хв (`grep -n '14:45' incident/oncall-chat.md | cut -c1-12`
  → `19:- **14:45` — рядок 19 чату, «відкочую на 1.7.3, на всяк випадок»); рестарт тієї самої
  версії нічого не змінив.
- **`pickup` бере з'єднання тричі, без транзакції** (`grep -n 'withConnection' app/src/parcels.js | cut -d: -f1 | tr '\n' ' '` →
  `43 61 64 67 74 80 85`; у `pickup` (рядки 59–69) — три окремі: `61`, `64`, `67`): під час насичення пулу таймаут міг статися між оновленням статусу і
  відповіддю терміналу. Наслідок для даних з наявних логів не виміряти (404 логуються вибірково).
- **Образ `poshtomat:latest`** у compose: за самим compose не видно, яка версія з якою
  конфігурацією працює, і відкат не прив'язаний до незмінного артефакту.

## Впевненість

**Висока.** Механізм відтворюється детерміновано (доказ 3: `DB_POOL_SIZE` → пул 4); межі
інциденту збігаються з межами роботи v1.8.0 до секунд (доказ 13); стеля `db_pool_in_use` рівно 4
весь період (доказ 5) — саме дефолт із `config.js`; той самий трафік 13.10 потребував 10–13
з'єднань (доказ 6); кожне альтернативне пояснення має ту саму картину в контрольний день без
інциденту. **Чого бракує:** зрізу фактичного оточення контейнера під час інциденту
(`docker compose exec api printenv`) і метрик самої PostgreSQL; припускаю, що на VM було
розгорнуто саме той `compose.yaml`, що в `incident/changes/v1.8.0.diff`. Змінити висновок могло б
лише свідчення, що в контейнері v1.8.0 фактично була задана `DB_POOL_MAX=20` — але тоді стеля
рівно 4 не мала б пояснення.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | «Витік з'єднань БД у версії 1.8.0» — з'єднання нібито не повертаються в пул (припущення: прибрали `finally`/`release()`) | Перейменування `DB_POOL_MAX` → `DB_POOL_SIZE` у `compose.yaml` релізу v1.8.0; `config.js` читає стару назву → дефолт 4 замість 20 → таймаути пулу → 503 |
| Впевненість, яку заявив AI | «Висока (~95 %)» | «Висока» |
| Збігається з вашою? | **Частково (механізм — ні).** Правильно прив'язав інцидент до деплою v1.8.0 і до пулу, правильно відкинув SMS 429 і баг `trim`. Але механізм хибний — витоку немає (див. «що НЕ є причиною»), а «стрибок пачок SMS о 14:00» — теж хибний (13.10 те саме). Дія з такого RCA («шукати витік у коді») нічого б не дала: код роботи з БД у релізі не змінювався. Заявлені 95 % не відповідали доказам. | **Так.** Механізм, хронологія і відкинуті хибні сліди (SMS 429, heap, TLS-таймаут) збігаються з моїми. Не порівнював явно з baseline 13.10 і не пояснив, чому `/health` був 200, — це додано тут. Дрібні неточності в деталях: «`db_pool_waiting` = 14–23» (у даних о 14:02 — `4`, о 14:20 — `6`: `awk -F, '$1 ~ /T14:02\|T14:20/' incident/metrics/2026-10-14.csv` → `…,11.9,945,0.0042,4,4,42,44` / `…,11.1,3270,0.0676,4,6,43,37`); «SMS 429 тривали аж до 15:03» — останній 429 о `15:01:15`, а 15:03 — час закриття алерту (хронологія). На висновок не впливають. |
| Що в даних вплинуло на відповідь | — (без diff і коду AI бачив лише симптом «пул = 4» і заповнив прогалину найпоширенішим шаблоном — «leak») | Вирішальною була пара `incident/changes/v1.8.0.diff` (`-DB_POOL_MAX` / `+DB_POOL_SIZE`) + `app/src/config.js:9` (`\|\| 4`): число 4 з метрик отримало пояснення. `deploys.log` і `oncall-chat.md` допомогли розібрати хибні сліди, але першопричину дала саме пара «diff + config.js». |
