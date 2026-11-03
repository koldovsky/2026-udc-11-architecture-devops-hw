# RCA: інцидент 2026-10-14 — «Сервіс зайнятий» на поштоматах

> Кожне твердження — з командою (Git Bash, з кореня репо) і її результатом. Час — Europe/Kyiv.
> Допоміжний скрипт для метрик — той, що в `docs/walkthrough.md` (розділ Task C); нижче він
> позначений як `stat <файл> <колонка> <від> <до>`:
>
> ```bash
> stat() { node -e '
> const [file, col, from, to] = process.argv.slice(1);
> const [head, ...rows] = require("fs").readFileSync(file, "utf8").trim().split("\n");
> const i = head.split(",").indexOf(col);
> const v = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from && r[0].slice(11, 16) < to).map((r) => +r[i]);
> console.log(col, from + "-" + to, "avg", (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), "max", Math.max(...v));
> ' "$@"; }
> ```

## Коротко

З 14:02 до 14:47 API відповідав `503 service busy, try again` на ~11 % запитів, p95 — 4,5 с; мешканці
не могли забрати посилки (2586 невдалих `POST /pickup`). Причина — реліз v1.8.0: у «чистці конфігу»
змінну `DB_POOL_MAX` у `deploy/compose.yaml` перейменували на `DB_POOL_SIZE`, яку застосунок не читає,
тож пул з'єднань до БД мовчки впав з 20 до дефолтних 4. Усунуто відкатом на v1.7.3 о 14:47.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 13:28:51 | Перші 429 від SMS-провайдера — як і щодня після обіду (13.10 — о 13:24:56) | `grep -m1 'rate limited' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl \| cut -c1-75` |
| 13:37 | `SmsProvider429RateHigh` (warning); чергова: «Повідомлення доходять… поки не чіпаю» | `incident/alerts.json`, `incident/oncall-chat.md:5-6` |
| 14:01:37 | Поодинокий `TLS handshake timeout to sms.example.net` у worker | `grep -n 'sms send failed' incident/logs/worker-2026-10-14.jsonl` |
| 14:01:58–14:02:07 | Деплой v1.8.0: SIGTERM, старт api `1.8.0` (14:02:00) і worker `1.8.0` (14:02:07) | `grep -E '"msg":"(service started\|worker started\|shutting down)"' incident/logs/*.jsonl`; `incident/deploys.log` |
| 14:02 | `db_pool_in_use` 12 → **4**, `db_pool_waiting` 0 → 4; p95 245 → 945 мс | `grep -E 'T14:0[12]:' incident/metrics/2026-10-14.csv` |
| 14:02:07 | Перший `db pool wait timeout after 2000ms` (503) | `grep -m1 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| cut -c1-40` |
| 14:06 / 14:07 | `ApiLatencyP95High`, `Api5xxRateHigh` (page) | `incident/alerts.json` |
| 14:08–14:14 | Гаряча лінія: «Сервіс зайнятий»; підозри на SMS-провайдера, heap, TLS-помилку | `incident/oncall-chat.md:9-13` |
| 14:20:29–14:20:31 | Рестарт лише api на тій самій 1.8.0 — пул знову 4, 503 тривають | `incident/deploys.log`; `grep -E 'T14:2[01]:' incident/metrics/2026-10-14.csv` |
| 14:36 | Провайдер SMS: «інцидентів немає» | `incident/oncall-chat.md:18` |
| 14:46:58–14:47:01 | Відкат на v1.7.3 (api і worker) | `incident/deploys.log`; логи `service started 1.7.3` |
| 14:46:58 | Останній `db pool wait timeout` | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| tail -1 \| cut -c1-40` |
| 14:47 | `db_pool_in_use` = 14, waiting 0, p95 618 → 296 мс | `grep -E 'T14:4[78]:' incident/metrics/2026-10-14.csv` |
| 14:48 | Пейджі закрито | `incident/alerts.json` |
| 15:03 | `SmsProvider429RateHigh` закрито — після спаду пікового обсягу SMS, як і 13.10 | `incident/alerts.json` |

## Першопричина

1. **Що змінилося.** Реліз v1.8.0 «config cleanup (#212)» відсортував змінні в `deploy/compose.yaml`
   за алфавітом і заодно перейменував `DB_POOL_MAX: "20"` на `DB_POOL_SIZE: "20"` в `api` і `worker`
   (`incident/changes/v1.8.0.diff:86-87, 106-107`). У коді застосунку (`src/config.js`) нічого не
   змінилося.
2. **Що через це стало інакше.** `loadConfig()` читає лише `env.DB_POOL_MAX`, а якщо її немає — бере
   дефолт для локальної розробки: `Number(env.DB_POOL_MAX) || 4` (`app/src/config.js:8-9`). Невідому
   `DB_POOL_SIZE` ніхто не читає і про неї не попереджає. Пул API став 4 з'єднання замість 20.
3. **Чому користувачі побачили саме цей симптом.** Після обіду API тримає 10–13 одночасних
   з'єднань при ~12 rps (так само 13.10). У 4 вони не влазять: запити чекають у черзі пулу, і через
   `DB_POOL_WAIT_MS=2000` отримують `PoolTimeoutError` (`app/src/db.js:72-79`), який сервер перетворює
   на `503 {"error":"service busy, try again"}` (`app/src/server.js:65`) — екран поштомата показує
   «Сервіс зайнятий». `POST /pickup` бере з'єднання тричі поспіль (`app/src/parcels.js:61-67`), тож
   видачі страждали найбільше. `/health` у БД не ходить (`app/src/server.js:37`) і віддавав 200 увесь час.
4. **Чому рестарт не допоміг, а відкат допоміг.** Рестарт о 14:20 підняв той самий образ з тим самим
   compose — знову 4. Відкат повернув compose v1.7.3 з `DB_POOL_MAX` — пул 20, черга зникла за хвилину.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | v1.8.0 перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` в обох сервісах | `grep -n 'DB_POOL' incident/changes/v1.8.0.diff` | рядки 86–87 і 106–107: `-DB_POOL_MAX: "20"` / `+DB_POOL_SIZE: "20"` |
| 2 | Застосунок читає лише `DB_POOL_MAX`, інакше дефолт 4 | `grep -rn 'DB_POOL' app/src` | `app/src/config.js:9: dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,` — `DB_POOL_SIZE` ніде |
| 3 | v1.8.0 справді працював з 14:02 до 14:47 | `grep -E '"msg":"service started"' incident/logs/api-2026-10-14.jsonl` | `14:02:00 … 1.8.0`, `14:20:31 … 1.8.0`, `14:47:00 … 1.7.3` |
| 4 | Під v1.8.0 пул стоїть рівно на 4 (кожна хвилина 14:03–14:46) | `awk -F, 'NR>1 && substr($1,12,5)>="14:03" && substr($1,12,5)<"14:47" {print $5}' incident/metrics/2026-10-14.csv \| sort \| uniq -c` | `44 4` — 44 з 44 хвилин |
| 5 | Той самий час 13.10 потребує 10–13 з'єднань і не чекає | `stat incident/baseline/metrics-2026-10-13.csv db_pool_in_use 14:03 14:47`; те саме для `db_pool_waiting` | `avg 11.8 max 13`; `avg 0.0 max 0` |
| 6 | 14.10 у цей час — черга на пул | `stat incident/metrics/2026-10-14.csv db_pool_waiting 14:03 14:47` | `avg 17.6 max 23` (13.10 — 0) |
| 7 | Трафік такий самий, як учора — навантаження ні до чого | `stat incident/metrics/2026-10-14.csv rps 14:03 14:47`; те саме для 13.10 | `avg 11.8` проти `avg 11.8` |
| 8 | Симптом: p95 і частка 5xx | `stat incident/metrics/2026-10-14.csv p95_ms 14:03 14:47`; `… error_rate 14:03 14:47` | `avg 4556.4 max 4962`; `avg 0.1 max 0.1347` (13.10: `p95 avg 236.5`, `error_rate max 0.0069`) |
| 9 | 503 — це саме таймаут пулу, і лише під v1.8.0 | `grep '"level":"error"' incident/logs/api-2026-10-14.jsonl \| grep -o '"error":"[^"]*"' \| sort \| uniq -c` | `3380 "db pool wait timeout after 2000ms"`, `125 …'trim'` |
| 10 | Таймаути пулу — тільки 14:02:07–14:46:58, і жодного 13.10 | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| sed -n '1p;$p' \| cut -c8-30`; `grep -c 'db pool wait timeout' incident/baseline/api-2026-10-13.jsonl` | `2026-10-14T14:02:07.172`, `2026-10-14T14:46:58.204`; `0` |
| 11 | Найбільше постраждала видача | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | `/pickup 2586`, `/parcels 650`, `/admin/parcels 144` |
| 12 | Рестарт без зміни конфігу не допоміг | `grep -E 'T14:2[0-2]:' incident/metrics/2026-10-14.csv \| cut -d, -f1,3,5,6` | 14:20 `3270,4,6` → 14:21 `4588,4,20` — пул і далі 4 |
| 13 | Відкат одразу повернув пул | `grep -E 'T14:4[6-8]:' incident/metrics/2026-10-14.csv \| cut -d, -f1,3,5,6` | 14:46 `4697,4,17` → 14:47 `618,14,0` → 14:48 `296,11,0` |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Хто назвав | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|---|
| SMS-провайдер «душить нас» 429 | чергова в чаті (`oncall-chat.md:10`) | алерт о 13:37, тисячі `sms provider rate limited` | 13.10 без жодного деплою — те саме: `grep -c 'rate limited' incident/baseline/worker-2026-10-13.jsonl incident/logs/worker-2026-10-14.jsonl` → `2935` / `3065`; почалося о 13:28, за 34 хв до 503, і тривало після відкату до ~15:00. Worker — окремий процес зі своїм пулом (`app/src/worker.js:43`), і жодного таймауту пулу у worker: `grep -c 'pool' incident/logs/worker-2026-10-14.jsonl` → `0` |
| «Масова розсилка / сплеск подій SMS о 13:28 у ~12 разів» | `ai-runs/rca-v1.md` | обсяг SMS різко зростає саме перед інцидентом | це щоденний післяобідній пік: сума `count` у `sms batch sent` по годинах — 14.10 `{"12":834,"13":6104,"14":11410,"15":1127}`, 13.10 `{"12":832,"13":5967,"14":10828,"15":1115}` (команда: `grep '"sms batch sent"' <файл> \| node -e 'const m={};require("readline").createInterface({input:process.stdin}).on("line",l=>{const j=JSON.parse(l);m[j.ts.slice(11,13)]=(m[j.ts.slice(11,13)]\|\|0)+j.count}).on("close",()=>console.log(JSON.stringify(m)))'`) |
| Витік пам'яті в api (heap 81 %) | чергова (`oncall-chat.md:11`) | `heap usage high` у логах під час інциденту | 13.10 таких попереджень навіть більше: `grep -c 'heap usage high' incident/baseline/api-2026-10-13.jsonl incident/logs/api-2026-10-14.jsonl` → `70` / `63`; `stat … heap_used_pct 14:03 14:47` → 14.10 `avg 65.7 max 82`, 13.10 `avg 68.5 max 82` — пилка GC, не ріст |
| Провайдер «почав глючити раніше»: `TLS handshake timeout` о 14:01:37 | чергова (`oncall-chat.md:13`) | перша помилка «перед усім цим», за 25 с до деплою | одинична і щоденна: `grep -c 'TLS handshake timeout' incident/baseline/worker-2026-10-13.jsonl incident/logs/worker-2026-10-14.jsonl` → `1` / `1`; до того ж це worker, а 503 віддає api |
| 500 `Cannot read properties of undefined (reading 'trim')` на `POST /parcels` | обидва прогони AI (як окремий баг) | 5xx у тих самих логах | хронічні, і поза інцидентом теж: `grep -c "reading 'trim'" incident/baseline/api-2026-10-13.jsonl incident/logs/api-2026-10-14.jsonl` → `128` / `125`; це 500, а не 503 з екрана; ~0,3 % проти порогу алерту 5 % |
| Код v1.8.0 (новий текст SMS, перейменований лог) | — (перевіряв сам) | реліз зачепив `worker.js` | diff коду змінює лише рядок SMS і текст логу (`sed -n '/^diff --git a\/app\/src\/worker.js/,/^diff --git a\/app\/test/p' incident/changes/v1.8.0.diff \| grep '^[-+] '` → лише текст `arrivalText` і `"sms delivery failed"`); у worker після деплою немає жодної помилки відправки: `grep -c 'sms delivery failed' incident/logs/worker-2026-10-14.jsonl` → `0`; api-код не змінювався |
| Зростання навантаження | — (перевіряв сам) | інцидент — на піку дня | rps як 13.10 (доказ 7) |
| Бекап БД блокує записи | — (перевіряв сам) | `docs/ops/backup-runbook.md:10-11` — блокування на запис | бекап — 02:00–02:30, а інцидент — 14:02–14:47 |

## Чинники, що сприяли (contributing factors)

- **Тихий дефолт у конфігу.** `loadConfig()` не перевіряє ні невідомих, ні відсутніх змінних і мовчки
  бере дефолт «для локальної розробки» навіть у продакшні (`app/src/config.js:8-9`); при старті
  фактичний розмір пулу не логується (`app/src/server.js:95` пише лише версію).
- **`/health` не перевіряє залежності.** Він не ходить у БД (`app/src/server.js:37`) — моніторинг і
  чергова бачили 200 весь інцидент (`incident/oncall-chat.md:17`).
- **«Косметичний» реліз з функціональною зміною.** Перейменування сховалося серед сортування за
  алфавітом; рев'ю й автор вважали реліз несуттєвим (`incident/oncall-chat.md:12`). Немає перевірки,
  що імена змінних у compose збігаються з тими, що читає код.
- **Деплой на піку дня і без smoke-перевірки** справжнім запитом: 14:02, коли розвантажуються машини
  доставки (`materials/feature-brief.md:44-45`); перший сигнал — пейдж через 4 хв.
- **Шумний алерт відволік діагностику.** `SmsProvider429RateHigh` горить щодня після обіду:
  `SMS_RATE_PER_SEC: "20"` у compose (`git show main:deploy/compose.yaml | grep -n SMS_RATE` → рядки 20 і 34: `"20"`) вдвічі
  більше за ліміт провайдера 10/с (`materials/vendors/sms-provider.md:16-17`). Чергова 30 хв шукала
  причину в провайдері й писала в його підтримку.
- **Немає алерту на насичення пулу** (`db_pool_waiting > 0`), хоча метрика є: причину видно з першої
  хвилини (доказ 4–6).
- **Відкат — «на всяк випадок» через 45 хв** (`incident/deploys.log`), бо в runbook немає правила
  «був деплой ≤ 60 хв тому → спершу відкат».

## Впевненість

**Висока.** Механізм повністю простежується в коді (`config.js:9` → `db.js:72-79` → `server.js:65`);
перейменування видно в diff; стеля пулу рівно 4 = дефолт з коду, 44 хвилини з 44; початок і кінець 503
збігаються з деплоєм і відкатом до секунд, а рестарт без зміни конфігу не допоміг; трафік і всі
«підозрювані» (429, heap, TLS, trim) такі самі в день без інциденту. Чого бракує: самого
`deploy/compose.yaml` з VM на момент інциденту — я спираюся на diff релізу; висновок змінило б лише
те, що на VM стояв інший compose, ніж у релізі (але тоді стеля 4 не мала б пояснення).

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | реліз 1.8.0: «ліміт пулу з'єднань до БД фактично становить 4»; **чому** 4 — «з наявних даних не видно» (змінили конфіг чи код тримає з'єднання) | перейменування `DB_POOL_MAX` → `DB_POOL_SIZE` у compose v1.8.0, `config.js:9` бере дефолт 4 |
| Впевненість, яку заявив AI | «висока, ~90%» — що причина в 1.8.0 | «висока (~95 %)» |
| Збігається з вашою? | частково — механізм (пул 4 → таймаути → 503) і межі збігаються, механізму «чому 4» немає; хибно приписав 429 «масовій розсилці» (обсяг SMS — щоденна норма, див. таблицю вище) | так — збігається повністю, включно з поясненням `/health` = 200 і «рестарт не допоміг» |
| Що в даних вплинуло на відповідь | — | `changes/v1.8.0.diff` (видно перейменування) + `app/src/config.js:9` (видно дефолт 4) — саме ця пара дала «чому»; `baseline/` дозволив назвати 429, heap і TLS щоденною нормою з числами (v1 спростовував їх лише за динамікою в один день). Жоден прогін не помітив, що щоденні 429 спричиняє `SMS_RATE_PER_SEC: "20"` при ліміті 10/с — v2 мав і `deploy/`, і код, але не мав `materials/vendors/` |
