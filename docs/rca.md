# RCA: інцидент 2026-10-14 — поштомати не видають посилки

Усі команди — з кореня репо, Git Bash. Час — Europe/Kyiv.

Для метрик використовується одна допоміжна функція (середнє і максимум колонки за проміжок
`[від, до)`) — спершу вставте її в термінал:

```bash
m() { node -e 'const [f,c,a,b]=process.argv.slice(1);const [h,...r]=require("fs").readFileSync(f,"utf8").trim().split("\n");const i=h.split(",").indexOf(c);const v=r.map(x=>x.split(",")).filter(x=>x[0].slice(11,16)>=a&&x[0].slice(11,16)<b).map(x=>+x[i]);console.log(c,a+"-"+b,"avg",(v.reduce((s,y)=>s+y,0)/v.length).toFixed(2),"max",Math.max(...v))' "$@"; }
```

## Коротко

З 14:02 до 14:47 API відповідав `503 «service busy, try again»` приблизно на кожен
дев'ятий запит (error rate у середньому 11 %), а p95 зріс з ~0,2 до ~4,5 с: мешканці не могли
забрати посилки, служба доставки — зареєструвати нові. Причина — реліз v1.8.0
перейменував у `deploy/compose.yaml` змінну `DB_POOL_MAX` на `DB_POOL_SIZE`, яку код не читає.
Через це пул з'єднань API тихо впав з 20 до значення за замовчуванням 4. Відкат на v1.7.3
повернув стару назву змінної, і сервіс відновився.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| з ~13:30 | 429 від SMS-провайдера ростуть з ростом трафіку — так само, як і 13.10 (див. «що НЕ є причиною») | `grep -E 'T13:3[0-7]:' incident/metrics/2026-10-14.csv` |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning) | `incident/alerts.json` |
| 14:01:37 | Одиничний `TLS handshake timeout to sms.example.net` у worker-і (ще v1.7.3) | `grep -h 'TLS handshake' incident/logs/worker-2026-10-14.jsonl` |
| 14:01:58 | SIGTERM api і worker — початок розгортання v1.8.0 | `grep -h '"shutting down"' incident/logs/*.jsonl` |
| 14:02:00 | `service started` v1.8.0; `deploy v1.8.0 config cleanup (#212)` | `grep -h '"service started"' incident/logs/api-2026-10-14.jsonl`; `grep -n v1.8.0 incident/deploys.log` |
| 14:02 | Хвилина метрик: `db_pool_in_use` 12 → **4**, `db_pool_waiting` 0 → 4, p95 245 → 945 мс | `grep -E 'T14:0[0-4]:' incident/metrics/2026-10-14.csv` |
| 14:02:07 | Перший `db pool wait timeout after 2000ms` → 503 | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| head -1` |
| 14:06 | Пейдж `ApiLatencyP95High` | `incident/alerts.json` |
| 14:07 | Пейдж `Api5xxRateHigh` | `incident/alerts.json` |
| 14:20:31 | Перезапуск лише api, та сама v1.8.0 — пул знову 4, p95 знову ~4,6 с | `grep -n restart incident/deploys.log`; `grep -E 'T14:(19\|20\|21):' incident/metrics/2026-10-14.csv` |
| 14:46:58 | Останній `db pool wait timeout`; SIGTERM api і worker | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| tail -1` |
| 14:47:00 | Відкат: `service started` v1.7.3; хвилина метрик: `db_pool_in_use` **14**, `waiting` 0, p95 618 мс | `grep -E 'T14:(46\|47):' incident/metrics/2026-10-14.csv` |
| 14:48 | Пейджі закрито | `incident/alerts.json` |
| 15:03 | `SmsProvider429RateHigh` закрито — коли спав трафік, а не через відкат | `incident/alerts.json` |

## Першопричина

1. **Що змінилося.** Реліз v1.8.0 «config cleanup (#212)» відсортував змінні в
   `deploy/compose.yaml` за алфавітом і заодно перейменував `DB_POOL_MAX: "20"` на
   `DB_POOL_SIZE: "20"` для обох сервісів (`incident/changes/v1.8.0.diff:86-87,106-107`).
2. **Що через це стало інакше.** Код читає лише `DB_POOL_MAX` і мовчки підставляє `4`, якщо
   змінної немає: `dbPoolMax: Number(env.DB_POOL_MAX) || 4` (`app/src/config.js:9`).
   `DB_POOL_SIZE` у коді не читає ніхто. Отже з 14:02 API працював з пулом **4** замість 20 —
   без жодного попередження в лозі.
3. **Чому користувачі побачили саме це.** У пікові години (~12 rps) API тримає ~12 з'єднань
   одночасно (13.10 о тій самій порі — у середньому 11,8, максимум 13). З лімітом 4 решта
   запитів ставала в чергу пулу; хто чекав довше за `DB_POOL_WAIT_MS` = 2000 мс, отримував
   `PoolTimeoutError` (`app/src/db.js:72-78`), а API перетворював її на
   `503 «service busy, try again»` (`app/src/server.js:65`) — це і є «Сервіс зайнятий» на
   екрані поштомата. Ті, хто дочекався, отримували відповідь за 2–5 с (p95 ~4,5 с).
4. **Чому `/health` весь час відповідав 200.** `/health` не бере з'єднання з пулу
   (`app/src/server.js:37`), тож пул на 4 його не зачіпає.
5. **Чому перезапуск о 14:20 не допоміг, а відкат допоміг.** Перезапуск підняв той самий
   образ із тим самим compose — знову без `DB_POOL_MAX`. Відкат на v1.7.3 повернув compose зі
   `DB_POOL_MAX: "20"`: уже в хвилину 14:47 `db_pool_in_use` = 14, черга 0.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | v1.8.0 перейменував `DB_POOL_MAX` → `DB_POOL_SIZE` | `grep -n 'DB_POOL' incident/changes/v1.8.0.diff` | `86:-  DB_POOL_MAX: "20"`, `87:+  DB_POOL_SIZE: "20"`, те саме в рядках 106–107 |
| 2 | Код читає лише `DB_POOL_MAX`, за замовчуванням 4 | `grep -n 'DB_POOL' app/src/config.js` | `9: dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,` |
| 3 | `DB_POOL_SIZE` у коді не читається ніде | `grep -rn 'DB_POOL_SIZE' app` | порожньо |
| 4 | З конфігом v1.8.0 пул = 4, з v1.7.3 — 20 | `node -e 'import("./app/src/config.js").then(c=>console.log(c.loadConfig({DB_POOL_SIZE:"20"}).dbPoolMax, c.loadConfig({DB_POOL_MAX:"20"}).dbPoolMax))'` | `4 20` |
| 5 | Під час інциденту пул API весь час рівно 4 | `m incident/metrics/2026-10-14.csv db_pool_in_use 14:02 14:47` | `avg 4.00 max 4` |
| 6 | При тому самому трафіку 13.10 API тримав ~12 з'єднань | `m incident/baseline/metrics-2026-10-13.csv db_pool_in_use 14:02 14:47` | `avg 11.82 max 13` |
| 7 | Трафік такий самий, як 13.10 — не сплеск | `m incident/metrics/2026-10-14.csv rps 14:02 14:47`; `m incident/baseline/metrics-2026-10-13.csv rps 14:02 14:47` | `avg 11.80 max 12.8`; `avg 11.85 max 12.5` |
| 8 | Запити стояли в черзі пулу | `m incident/metrics/2026-10-14.csv db_pool_waiting 14:02 14:47` | `avg 17.31 max 23` |
| 9 | Усі нові помилки — тайм-аут пулу; 13.10 їх не було | `grep -o '"error":"[^"]*"' incident/logs/api-2026-10-14.jsonl \| sort \| uniq -c`; те саме для `incident/baseline/api-2026-10-13.jsonl` | 14.10: `3380 db pool wait timeout after 2000ms`, `125 …reading 'trim'`; 13.10: лише `128 …reading 'trim'` |
| 10 | Тайм-аути — рівно між деплоєм і відкатом | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| sed -n '1p;$p' \| cut -c1-40` | `14:02:07.172` … `14:46:58.204` |
| 11 | Тайм-аут пулу → 503 «service busy» | `grep -n 'PoolTimeoutError) \[status' app/src/server.js` | `65: … [503, { error: "service busy, try again" }]` |
| 12 | Вплив: які запити падали | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | `/pickup` 2586, `/parcels` 650, `/admin/parcels` 144 (API логує кожну 5xx — `incident/README.md:31`) |
| 13 | Симптом: p95 і частка 5xx | `m incident/metrics/2026-10-14.csv p95_ms 14:02 14:47`; `m incident/metrics/2026-10-14.csv error_rate 14:02 14:47` | `avg 4476.16 max 4962`; `avg 0.11 max 0.1347` |
| 14 | Перезапуск о 14:20 не змінив пул | `m incident/metrics/2026-10-14.csv db_pool_in_use 14:21 14:47` | `avg 4.00 max 4` |
| 15 | Відкат відновив пул одразу | `grep -E 'T14:(46\|47):' incident/metrics/2026-10-14.csv` | `14:46 … p95 4697, in_use 4, waiting 17`; `14:47 … p95 618, in_use 14, waiting 0` |
| 16 | Після відкату — як до інциденту | `m incident/metrics/2026-10-14.csv p95_ms 14:48 16:00` | `avg 187.44 max 296` |
| 17 | Версії процесів збігаються з вікном інциденту | `grep -h '"service started"\|"worker started"' incident/logs/*.jsonl` | api 1.8.0 о 14:02:00 і 14:20:31, 1.7.3 о 14:47:00 |
| 18 | `/health` пул не використовує | `grep -n '"/health"' app/src/server.js` | `37: … return [200, { status: "ok", version }]` — без `withConnection` |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS-провайдер «душить» нас 429-ми (чергова, 14:10) | алерт о 13:37, тисячі `sms provider rate limited` у лозі worker-а | 13.10, без інциденту, — те саме: `grep -c 'sms provider rate limited' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `3065` і `2935`; `m incident/metrics/2026-10-14.csv sms_429_per_min 14:02 14:47` → `avg 34.82`, на 13.10 → `avg 33.02`. До того ж 429 не дійшли б до API: worker — окремий процес зі своїм пулом (`grep -n createPool app/src/server.js app/src/worker.js` → `server.js:91`, `worker.js:43`) |
| Провайдер «почав глючити» раніше — `TLS handshake timeout` о 14:01:37 (чергова, 14:14) | перша помилка за 25 с до деплою | одиничний збій, такий самий був 13.10: `grep -h 'TLS handshake' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl \| cut -c1-40` → `2026-10-14T14:01:37` і `2026-10-13T13:12:45`; помилки в API — лише тайм-аути пулу (доказ 9) |
| Витік пам'яті в API (чергова, 14:12; «щось із пам'яттю», 14:50) | `heap usage high`, heap 81 % | 13.10 — так само: `grep -c 'heap usage high' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `63` і `70`; `m incident/metrics/2026-10-14.csv heap_used_pct 14:02 14:47` → `avg 65.16 max 82`, на 13.10 → `avg 68.82 max 82`. Перезапуск о 14:20 скинув heap до 43 %, а p95 лишився 4588 мс: `grep -E 'T14:(19\|20\|21):' incident/metrics/2026-10-14.csv` |
| **Прогін 1 AI:** worker v1.8.0 «витікав DB-з'єднання» і забрав глобальний ліміт БД, API «отримав лише 4»; «відновлення без рестарту API» | перший тайм-аут через 0,16 с після `worker started`; відновлення в хвилину SIGTERM worker-а | (1) `db_pool_in_use` — пул **у процесі API** (`incident/README.md:46`), і в кожного процесу свій пул (`app/src/server.js:91`, `app/src/worker.js:43`); стеля 4 = `max` пулу API (доказ 4); (2) вичерпання з'єднань БД дало б помилки підключення, а їх немає: `grep -ci 'too many\|max_connections\|ECONNREFUSED' incident/logs/api-2026-10-14.jsonl` → `0`; (3) API **перезапускався** о 14:46:58–14:47:00 разом з worker-ом: `grep -h '"shutting down"\|"service started"' incident/logs/api-2026-10-14.jsonl` → SIGTERM 14:46:58, `service started 1.7.3` 14:47:00; (4) перший тайм-аут (14:02:07.172) — на 7 с пізніше старту API v1.8.0 (14:02:00) і стався в API, у якого пул 4 з першої секунди |
| Сплеск трафіку (прогін 1: «трафік починає зростати») | rps з ~4 до ~12 протягом дня | щоденний профіль: доказ 7 — 11,80 проти 11,85 rps у той самий час 13.10 |
| Новий текст SMS у v1.8.0 | єдина зміна коду в релізі (`incident/changes/v1.8.0.diff:33-34`) | текст впливає лише на worker; 429 не змінилися (див. перший рядок), а помилок відправки з новим текстом — `grep -c 'sms delivery failed' incident/logs/worker-2026-10-14.jsonl` → `0` |
| Повільна PostgreSQL / бекап | 503 «зайнятий», тайм-аути до БД | вікно бекапу — 02:00–02:30 (`docs/ops/backup-runbook.md:10-11`), не вдень; у 13.10 з тим самим навантаженням p95 ~236 мс і 0 очікувань; падіння й відновлення збігаються з хвилиною зміни конфігу (докази 15, 17), а не з навантаженням на БД |
| `500 Cannot read properties of undefined (reading 'trim')` на `/parcels` | помилки в API-лозі з 12:39 | окремий давній баг (`sender.trim()` без перевірки, `app/src/parcels.js:42`): 13.10 — 128 таких самих, 14.10 — 125 (доказ 9); на `/pickup` не впливає |

## Чинники, що сприяли (contributing factors)

- **Тихе значення за замовчуванням.** `Number(env.DB_POOL_MAX) || 4` (`app/src/config.js:9`):
  відсутня змінна не валить старт і не пише попередження. Невідома змінна `DB_POOL_SIZE` теж
  ніде не помічається.
- **Немає перевірки, що змінні в compose читає код.** «Косметична» зміна конфігу пройшла без
  жодної автоматичної перевірки; тести застосунку compose не бачать.
- **`/health` не відображає здатність обслуговувати запити** (`app/src/server.js:37`) — 200
  весь інцидент, що збивало з пантелику (`incident/oncall-chat.md:17`).
- **Шумний алерт 429 щодня.** `SMS_RATE_PER_SEC: "20"` (`deploy/compose.yaml:20,34`) удвічі
  вище за ліміт провайдера 10/с (`materials/vendors/sms-provider.md:16`), тож 429 і алерт
  `SmsProvider429RateHigh` — норма щодня (умова виконувалась і 13.10 з 13:36 — команда нижче).
  Звичний шум став першою гіпотезою й забрав увагу.
  `node -e 'const r=require("fs").readFileSync("incident/baseline/metrics-2026-10-13.csv","utf8").trim().split("\n").slice(1).map(x=>x.split(","));let n=0;for(const x of r){n=+x[7]>20?n+1:0;if(n===5){console.log(x[0]);break}}'` → `2026-10-13T13:36:00+03:00`.
- **Немає метрики «пул заповнений» в алертах.** `db_pool_waiting` > 0 — однозначний сигнал
  (доказ 8), але алерти були лише на симптоми (p95, 5xx).
- **Зв'язок «деплой → алерт» не був очевидним.** Деплой о 14:02, пейдж о 14:06, але реліз
  описано як «нічого суттєвого» (`incident/oncall-chat.md:12`), і відкат зробили лише через
  45 хв «на всяк випадок».

## Впевненість

**Висока.** Механізм відтворюється командою (доказ 4), а метрика пулу API дорівнює рівно
новому ліміту протягом усього вікна і повертається з відкатом (докази 5, 14, 15). Трафік, 429,
heap і TLS-збої такі самі, як у звичайний день 13.10. Чого бракує: прямого виводу ефективного
конфігу з контейнера v1.8.0 (`printenv`) — але `deploy/compose.yaml` з дифу однозначний.
Висновок змінило б, якби `db_pool_in_use` під час інциденту коливався вище 4 або 13.10 при
тому самому пулі теж мав тайм-аути — дані показують протилежне.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | worker v1.8.0 «витікав DB-з'єднання або захоплював їх на старті», вичерпав глобальний ліміт БД, API «отримав лише 4» | v1.8.0 перейменував `DB_POOL_MAX` → `DB_POOL_SIZE`, `config.js:9` читає лише `DB_POOL_MAX` → пул API з 20 падає до 4 |
| Впевненість, яку заявив AI | 85 % | висока, 95 % |
| Збігається з вашою? | **частково**: правильно — «реліз v1.8.0» і «стеля рівно 4», 429 і TLS — супутні; неправильно — механізм (worker, глобальний ліміт БД) і факт «відновлення без рестарту API» (у лозі API — рестарт о 14:47:00) | **так** — і механізм, і хронологія, і хибні сліди (429, TLS, heap) |
| Що в даних вплинуло на відповідь | — | `incident/changes/v1.8.0.diff` (перейменування) разом з `app/src/config.js:9` (`\|\| 4`) і `incident/deploys.log` (14:20 — рестарт лише api, 14:47 — відкат). Без коду й дифу прогін 1 бачив лише «стелю 4» і мусив вигадати, звідки вона. Baseline 13.10 жоден прогін явно не використав: прогін 2 відкинув 429 і heap з міркувань, а не порівнянням з 13.10 |

