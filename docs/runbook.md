# Runbook: API повільний або повертає 5xx (`ApiLatencyP95High`, `Api5xxRateHigh`)

> Для чергового, який не бачив інциденту 2026-10-14. Кожен крок — команда, яку можна
> скопіювати, і що в її виводі означає «так» чи «ні». Приклад розбору — `docs/rca.md`.

## Звідки брати дані

- **VM і compose.** Усі команди `docker compose` нижче — на VM `poshtomat-prod-1` **з теки
  `/opt/poshtomat`** (`cd /opt/poshtomat` один раз на початку), без `-f`. Саме туди
  `pipeline/deploy.yml` кладе `compose.yaml` і там запускає compose, тож проєкт той самий —
  `poshtomat`, а не окремий стек. Образ і тег поточного релізу (`IMAGE`, `IMAGE_TAG`) pipeline
  записує в `/opt/poshtomat/.env` поруч із секретами, тому compose бере їх сам. Перевірка перед
  першою дією: `docker compose ls` показує `poshtomat` з `/opt/poshtomat/compose.yaml`.
  У `docker compose logs` завжди додавайте `--no-log-prefix`: інакше кожен рядок починається з
  `api-1  | ` і `cut -c…` нижче ріже не те.
- **Історія розгортань** — `/opt/poshtomat/deploys.log` (формат: `ts action version by note`;
  кожен деплой дописує туди pipeline, у `note` — тег образу `sha-…`; копія за 14.10 —
  `incident/deploys.log`).
- **Метрики** — поштохвилинний CSV із моніторингу в тому самому форматі, що `incident/metrics/*.csv`
  (`ts,rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting,heap_used_pct,sms_429_per_min`).
  Вивантажте два файли: за сьогодні (`metrics-today.csv`) і за **вчора, той самий проміжок**
  (`metrics-yesterday.csv`). Немає доступу до експорту — дивіться ті самі колонки на дашборді або
  попросіть SRE. Для тренування — `incident/metrics/2026-10-14.csv` і
  `incident/baseline/metrics-2026-10-13.csv`.
- **Функція `mstat`** (середнє/мін/макс колонки за проміжок `<від>`–`<до>`, ГГ:ХХ, напіввідкритий).
  Визначте один раз у сесії Git Bash / bash:
  ```bash
  mstat() { node -e '
  const [file, col, from, to] = process.argv.slice(1);
  const [head, ...rows] = require("fs").readFileSync(file, "utf8").trim().split("\n");
  const i = head.split(",").indexOf(col);
  const v = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from && r[0].slice(11, 16) < to).map((r) => +r[i]);
  console.log(col, from + "-" + to, "avg", +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), "min", Math.min(...v), "max", Math.max(...v));
  ' "$@"; }
  ```
  Нижче `<від>` — приблизно за 15 хв до першої сторінки, `<до>` — поточна хвилина (наприклад,
  `mstat metrics-today.csv db_pool_waiting 13:50 14:10`).

## Алерти і вплив

- **Алерт(и):**
  - `ApiLatencyP95High` (page) — `p95_ms > 2000` протягом 3 хв;
  - `Api5xxRateHigh` (page) — `error_rate > 0.05` протягом 3 хв;
  - супутні сигнали, які **зазвичай не є причиною**: warning `SmsProvider429RateHigh`
    (`sms_429_per_min > 20` 5 хв — умова виконується щодня близько 13:36, у пік прибуття
    посилок) і `heap usage high` у лозі API (пилка ≈54–82 % — нормальна робота GC).
- **Що це означає для користувачів:** поштомат після введення коду показує «Сервіс зайнятий,
  спробуйте пізніше» (`503 service busy`) або довго думає; мешканці не можуть забрати посилки,
  кур'єри — зареєструвати нові (`POST /parcels`).
- **Скільки є часу:** вплив уже є, коли прийшла сторінка. У пік (≈13:20–15:00, ~11–12 rps) кожні
  10 хв — це ≈ 7 тис. запитів, із них при ~11 % помилок — сотні відмов. Ціль — рішення «відкат чи
  ні» за **10 хв** від сторінки.

## Перші 5 хвилин

1. **Підтвердіть сторінку в `#poshtomat-oncall`** («взяла/взяв, дивлюсь»).
2. **Чи був деплой або рестарт за останні 2 години?** Це найсильніший сигнал.
   ```bash
   tail -n 5 deploys.log
   docker compose logs --no-log-prefix --since 2h api | grep -E 'service started|shutting down'
   ```
   Є `deploy` / `service started` з новою версією за ≤ 30 хв до першої сторінки → **йдіть одразу
   в «Що робити», рядок 1 (відкат)**, діагностику — паралельно або після.
3. **Що саме повертає API?** Типи помилок за останні 15 хв (кожна 5xx логується):
   ```bash
   docker compose logs --no-log-prefix --since 15m api | grep -o '"error":"[^"]*"' | sort | uniq -c | sort -rn
   ```
   - домінує `db pool wait timeout after 2000ms` → насичення пулу БД (→ «Діагностика», питання 1–3);
   - `Cannot read properties of undefined (reading 'trim')` — відомий фоновий дефект (≈ 125–130 за
     12:00–16:00, 500 на `/parcels`); якщо лише він — це **не** причина сторінки;
   - щось інше / нове → ескалація до розробника сервісу.
4. **`/health` не вірте.** Він відповідає 200, не звертаючись до БД. Перевірте шлях, що бере
   з'єднання з пулу, без побічних ефектів (фальшивий токен → пошук сесії в БД → 403; токен
   `runbook-probe` — навмисно неіснуючий, не секрет):

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -H 'Authorization: Bearer runbook-probe' http://localhost:8080/admin/parcels
   ```

   `503` або час ≥ 2 с — пул насичений. `403` за десятки мс означає лише, що **в цю мить** знайшлося
   вільне з'єднання, а не що пул здоровий: якщо крок 3 показує `db pool wait timeout` або питання 1
   «Діагностики» — `db_pool_waiting > 0`, вважайте пул насиченим, попри швидкий `403`.

## Діагностика

Порівнюйте **з тим самим часом учора** — більшість «дивних» сигналів у пік є щодня.

| Питання | Команда | Як читати результат |
|---|---|---|
| 1. Пул БД насичений? | `mstat metrics-today.csv db_pool_waiting <від> <до>; mstat metrics-today.csv db_pool_in_use <від> <до>` | `db_pool_waiting max > 0` — запити стоять у черзі на з'єднання. `db_pool_in_use` **весь час одне число** (min = max) — це стеля пулу. Далі — питання 2. |
| 2. Яка стеля пулу в процесі насправді? | `docker compose exec api node --input-type=module -e 'import { loadConfig } from "./src/config.js"; const c = loadConfig(); console.log({ dbPoolMax: c.dbPoolMax, dbPoolWaitMs: c.dbPoolWaitMs })'` | Очікувано `dbPoolMax: 20`. **`4`** — застосунок не отримав `DB_POOL_MAX` і взяв дефолт для локальної розробки (так було 14.10). |
| 3. Які змінні пулу реально задано контейнеру? | `docker compose exec api printenv \| grep -E '^DB_POOL'` | Має бути `DB_POOL_MAX=20` і `DB_POOL_WAIT_MS=2000`. Інша назва (`DB_POOL_SIZE`, одруківка) або відсутність → причина знайдена: розбіжність назв між `deploy/compose.yaml` і `app/src/config.js`. |
| 4. Чи зріс трафік? | `mstat metrics-today.csv rps <від> <до>; mstat metrics-yesterday.csv rps <від> <до>` | Різниця в межах ~10 % — навантаження звичайне, шукайте зміну в системі (деплой/конфіг). Помітно більше — реальний сплеск; при `dbPoolMax: 20` і `in_use = 20` → ескалація (рядок 3 «Що робити»). |
| 5. Пул на 20 і все одно черга? | `mstat metrics-today.csv db_pool_in_use <від> <до>` | `max 20` + `db_pool_waiting > 0` при звичайному трафіку → повільні запити в PostgreSQL або блокування — ескалація до DBA (PostgreSQL на тій самій VM, поза compose). |
| 6. SMS 429 — це нове? | `mstat metrics-today.csv sms_429_per_min <від> <до>; mstat metrics-yesterday.csv sms_429_per_min <від> <до>` | Схожі цифри (14.10 за 13:30–15:00: avg ≈ 34 / 13.10: ≈ 32) — щоденний шум. Worker — окремий процес із власним пулом, API до SMS-провайдера не звертається: 429 **не може** спричинити 503 в API. |
| 7. Heap — витік? | `mstat metrics-today.csv heap_used_pct <від> <до>; mstat metrics-yesterday.csv heap_used_pct <від> <до>` — беріть проміжок **без рестартів API** (рестарт видно в кроці 2 «Перших 5 хвилин») | Пилка ≈54–82 % в обидва дні — норма (14.10 і 13.10 за 12:00–14:02: `min 54 max 82` / `min 55 max 82`). Рестарт скидає heap до ~42 %, тому проміжок із рестартом покаже нижчий `min` — це не ознака проблеми. Витік — це коли **мінімум** росте година за годиною без рестартів або процес падає з OOM. |
| 8. Коли саме почалось? | `docker compose logs --no-log-prefix --since 2h api \| grep -m1 'db pool wait timeout' \| cut -c8-36` | Час першого таймауту пулу. Порівняйте з `service started` (крок 2 «Перших 5 хвилин»): секунди після старту нової версії → причина в релізі (14.10: старт `14:02:00`, перший таймаут `14:02:07`). |

## Як підтвердити причину

Насичення пулу через конфігурацію (як 14.10) відрізняють **два факти**:

1. `db_pool_in_use` дорівнює одному й тому самому числу весь час і це число **менше за 20**
   (питання 1), а `dbPoolMax` у процесі — те саме число (питання 2).
2. Перша `db pool wait timeout` — через секунди після `service started` нової версії (питання 8),
   а трафік як учора (питання 4).

Якщо обидва «так» — причина в конфігурації релізу, рестарт **не допоможе** (14.10 рестарт о 14:20
нічого не змінив). Якщо стеля = 20 і деплою не було — це навантаження або БД (питання 4–5).

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| 1. Сторінка ≤ 30 хв після деплою (незалежно від того, чи знайдено причину) | **Відкат на попередню версію.** Не чекайте відповіді зовнішніх провайдерів і не робіть рестарт тієї самої версії | **Основний шлях — той самий pipeline** (лише в репо, де `pipeline/deploy.yml` підключено як workflow, тобто скопійовано в `.github/workflows/`; у репо курсу його навмисно тримають у `pipeline/`, і GitHub його не запускає — тоді одразу ручний шлях нижче): GitHub → Actions → «CI / Deploy» → Run workflow → «Use workflow from» = попередній тег (з `deploys.log`, напр. `v1.7.3`) → погодити environment `production`. Pipeline сам покладе `compose.yaml` цього тегу в `/opt/poshtomat` і перезапустить проєкт `poshtomat` (кілька хвилин: тести + збірка). **Швидше, вручну** (той самий проєкт): з ноутбука з репо спершу витягніть файл локально і лише тоді копіюйте **поруч**, а не поверх робочого: `git fetch --tags && git show <попередній-тег>:deploy/compose.yaml > compose.prev.yaml && test -s compose.prev.yaml && scp compose.prev.yaml poshtomat-prod-1:/opt/poshtomat/compose.prev.yaml` (помилка в назві тегу зупинить ланцюжок до `scp`). Далі на VM у `/opt/poshtomat` — спершу всі перевірки, `.env` змінюється **останнім** кроком: `export IMAGE_TAG=<sha-тег попереднього рядка deploys.log> && docker compose -f compose.prev.yaml config -q && ! docker compose -f compose.prev.yaml config --images \| grep -v ':sha-[0-9a-f]\{40\}$' && docker compose -f compose.prev.yaml pull api worker && cp compose.yaml compose.bad.yaml && mv compose.prev.yaml compose.yaml && docker compose up -d --no-build --wait --wait-timeout 120 && cp -p .env .env.tmp && sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$IMAGE_TAG/" .env.tmp && mv .env.tmp .env; unset IMAGE_TAG`. Тег задано змінною shell (вона важливіша за `.env`), тож `config -q` перевіряє файл, `config --images` — що **кожен** образ закріплено незмінним тегом `sha-…` (вивела рядок, напр. `poshtomat:latest` у compose релізу до цього pipeline, — ланцюжок зупинено: такий відкат не поверне попередню версію, ескалюйте до розробника), а `pull` — що образ є, і все це до будь-якої зміни. Ланцюжок зупинився **до** `mv compose.prev.yaml` — нічого не змінено. Зупинився на `up` — поверніть файл: `mv compose.bad.yaml compose.yaml && docker compose up -d --no-build` (`.env` ще старий, тож це попередній робочий стан). Зупинився **після** `up` (на `cp`, `sed` чи `mv .env.tmp .env`) — контейнери вже на попередньому релізі, а `.env` міг лишитися з тегом поганого: перевірте `grep '^IMAGE_TAG=' .env` і, якщо там не `<sha-тег попереднього рядка deploys.log>`, виправте `rm -f .env.tmp && cp -p .env .env.tmp && sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<sha-тег попереднього рядка deploys.log>/' .env.tmp && mv .env.tmp .env` — інакше наступний `docker compose up` без змінної shell поверне поганий реліз. Перевірка: `docker compose ls` — лише `poshtomat`; `docker compose logs --no-log-prefix --since 2m api \| grep 'service started'` | Відкат повертає і образ, і `compose.yaml`. Не запускайте `docker compose -f deploy/compose.yaml …` з git-checkout: це інший проєкт (`deploy`), він підніме другий стек, а робочий лишиться на поганій версії. Ручний шлях можливий лише для релізів, задеплоєних цим pipeline (їхній образ `sha-…` є в GHCR). Переконайтесь, що в релізі немає міграцій БД (подивіться diff релізу); якщо є — ескалація до розробника перед відкатом. Після — розділ «Як переконатися». Напишіть у канал версію і час. |
| 2. `dbPoolMax` ≠ 20 через неправильну назву змінної, а відкат неможливий | Виправити назву змінної в `/opt/poshtomat/compose.yaml` на ту, яку читає `src/config.js` (`DB_POOL_MAX`), і перестворити контейнери | `docker compose exec api grep -n 'env\.' src/config.js` (які назви читає код) → виправити `compose.yaml` → `docker compose up -d --no-build` | Це ручна зміна в проді — зафіксуйте її в `deploys.log` і в каналі; той самий фікс має потрапити в репозиторій, інакше наступний деплой поверне проблему. Повторіть питання 2–3. |
| 3. Деплою не було, стеля 20, трафік вище звичайного | Тримати; ескалація до власника сервісу щодо тимчасового збільшення пулу (і перевірки `max_connections` PostgreSQL) | `mstat …` питання 4–5 кожні 5 хв | Збільшення пулу без перевірки PostgreSQL може перевантажити БД — лише разом із DBA. |
| 4. Деплою не було, стеля 20, трафік звичайний | Ескалація до DBA: повільні запити / блокування | — (на боці PostgreSQL) | Рестарт API лише скине чергу на хвилину (див. 14:20 у `docs/rca.md`), але не виправить причину. |
| 5. Лише `SmsProvider429RateHigh` без сторінок API | Порівняти з учора (питання 6); якщо так само — нічого не робити, лише нотатка в каналі | `docker compose logs --no-log-prefix --since 30m worker \| grep -c -e 'sms send failed' -e 'sms delivery failed'` (до v1.8.0 повідомлення називалось `sms send failed`, з v1.8.0 — `sms delivery failed`) | Звичайно — одиниці за день (14.10 і 13.10 — по 1 за 12:00–16:00). Зростання означає, що SMS не доходять → ескалація до розробника worker-а. |

## Коли ескалювати і кого кликати

- **Одразу при сторінці після деплою** → автор релізу / розробник сервісу (на зв'язку в
  `#poshtomat-oncall`) — щоб підтвердити, що відкат безпечний (немає міграцій).
- **Вплив > 15 хв і причина не ясна** → лід ротації чергових як incident commander; він вирішує
  про відкат, якщо черговий вагається.
- **Стеля пулу 20 і черга без деплою** → DBA / власник PostgreSQL на VM.
- **Помилки, яких немає в цьому runbook** (новий `"error"` у кроці 3) → розробник сервісу.
- **SMS-провайдер** → лише якщо 429 або `sms send failed` / `sms delivery failed`
  (`grep -E 'sms (send|delivery) failed'`) суттєво вищі, ніж учора в цей час; самі по собі 429 у
  пік — норма (14.10 провайдер підтвердив, що інцидентів у них не було).
- Гаряча лінія / підтримка мешканців → повідомити, що видача посилок відновлена, коли пройде
  розділ нижче.

## Як переконатися, що все гаразд

Протягом **5 хв** після дії (відкату чи виправлення):

- `docker compose logs --no-log-prefix --since 5m api | grep -c 'db pool wait timeout'` → `0`.
- Проба пулу з кроку 4 «Перших 5 хвилин» → `403` за десятки мілісекунд.
- Метрики: `db_pool_waiting = 0`; `db_pool_in_use` знову **коливається** (у пік 10–13, а не одне
  й те саме число); `p95_ms` < 300 мс; `error_rate` < 0,01 (14.10 після відкату за 1–2 хв:
  p95 618 → 296 мс, черга 0).
- Обидва page-алерти закрились (за умовою — через ~1–3 хв після нормалізації).
- Ефективна конфігурація (питання 2) показує `dbPoolMax: 20`.
- Після цього — запис у каналі: що зроблено, о котрій, яка версія зараз працює; заведіть
  post-mortem, якщо вплив тривав > 10 хв.
