# RCA: інцидент 2026-10-14 — «Сервіс зайнятий» на поштоматах

> Кожне твердження — з командою, яку можна запустити з кореня репо в Git Bash, і її результатом.
> Колонки метрик: `ts,rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting,heap_used_pct,sms_429_per_min`
> (тобто `$5` = `db_pool_in_use`, `$6` = `db_pool_waiting`, `$8` = `sms_429_per_min`).

Команди `metric …` нижче — це функція зі скрипта в `docs/walkthrough.md` (середнє й максимум колонки за проміжок `[від, до)`). Один раз вставте її в Git Bash:

```bash
metric() { node -e 'const [file, col, from, to] = process.argv.slice(1); const [head, ...rows] = require("fs").readFileSync(file, "utf8").trim().split("\n"); const i = head.split(",").indexOf(col); const v = rows.map((r) => r.split(",")).filter((r) => r[0].slice(11, 16) >= from && r[0].slice(11, 16) < to).map((r) => +r[i]); console.log(col, from + "-" + to, "avg", (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), "max", Math.max(...v));' "$@"; }
```

## Коротко

З 14:02 до 14:47 (45 хв) API віддавав 503 «service busy, try again», і в середньому 11 % запитів, зокрема видачі посилок за кодом, завершувались помилкою. Причина в релізі v1.8.0 («config cleanup»): він перейменував у `deploy/compose.yaml` змінну `DB_POOL_MAX` на `DB_POOL_SIZE`, яку застосунок не читає. Пул з'єднань з БД мовчки зменшився з 20 до значення за замовчуванням 4, і в післяобідній пік запити не дочікувались з'єднання. Відкат на v1.7.3 повернув правильну назву змінної, і сервіс одразу відновився.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 12:39 | Перший фоновий 500 на `POST /parcels` (`…reading 'trim'`). Такі помилки йдуть увесь день і бувають щодня | `grep trim incident/logs/api-2026-10-14.jsonl \| cut -c19-23 \| head -1` |
| 13:28 | Перші `sms provider rate limited` (429) у worker. Так само щодня (13.10 — з 13:24) | `grep -m1 '"sms provider rate limited"' incident/logs/worker-2026-10-14.jsonl` |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning) | `incident/alerts.json` |
| 14:01:37 | Одиничне `TLS handshake timeout to sms.example.net` у worker | `grep TLS incident/logs/worker-2026-10-14.jsonl` |
| 14:01:58–14:02:07 | Деплой v1.8.0: SIGTERM, старт api 1.8.0 о 14:02:00, worker о 14:02:07 | `grep -E '"service started"\|"shutting down"' incident/logs/api-2026-10-14.jsonl`; `incident/deploys.log` |
| 14:02:07 | Перша помилка `db pool wait timeout after 2000ms` → 503 | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| head -1` |
| 14:02 | Хвилинна метрика: `db_pool_in_use` = 4, `waiting` = 4, p95 945 мс; далі 2446, 3477, 4565 мс | `awk -F, 'NR>1 && substr($1,12,5)>="14:00" && substr($1,12,5)<="14:05"' incident/metrics/2026-10-14.csv` |
| 14:06 / 14:07 | Пейджі `ApiLatencyP95High` і `Api5xxRateHigh` | `incident/alerts.json` |
| 14:08–14:14 | Чергова бере інцидент. Гіпотези: SMS-провайдер (429, TLS) і витік пам'яті (heap 81 %) | `incident/oncall-chat.md` |
| 14:20:31 | Перезапуск api на тій самій v1.8.0. Хвилину p95 3270 мс, далі знову ~4,6 с | `incident/deploys.log`; `awk -F, 'NR>1 && substr($1,12,5)>="14:19" && substr($1,12,5)<="14:22"' incident/metrics/2026-10-14.csv` |
| 14:36 | Провайдер SMS: «інцидентів немає» | `incident/oncall-chat.md` |
| 14:46:58 | Остання помилка пулу | `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| tail -1` |
| 14:47:00 | Відкат: api 1.7.3 стартував. `db_pool_in_use` = 14, `waiting` = 0 | `grep '"service started"' incident/logs/api-2026-10-14.jsonl \| tail -1`; метрика 14:47 |
| 14:48 | Пейджі закрито, p95 296 мс | `incident/alerts.json`; метрика 14:48 |
| 15:03 | Закрито `SmsProvider429RateHigh`, бо спав післяобідній трафік | `incident/alerts.json` |

## Першопричина

1. **Що змінилося.** Реліз v1.8.0 (`incident/deploys.log`: «config cleanup (#212)») відсортував змінні в `deploy/compose.yaml` і заодно перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` для обох сервісів (`incident/changes/v1.8.0.diff:86-87,106-107`). Код при цьому не змінено: `app/src/config.js:9` читає `Number(env.DB_POOL_MAX) || 4`.
2. **Що через це стало інакше.** `DB_POOL_MAX` зникла з оточення, тож `dbPoolMax` став значенням за замовчуванням **4** замість 20. Ні при старті, ні в логах нічого не повідомило: невідома змінна просто ігнорується.
3. **Чому користувачі побачили саме цей симптом.** У післяобідній пік (машини доставки, `rps` ≈ 12) API потребує 11–13 одночасних з'єднань. Так було і 13.10, і 14.10 до деплою. Із пулом 4 решта запитів стає в чергу (`db_pool_waiting` до 23). Хто не отримав з'єднання за `DB_POOL_WAIT_MS=2000`, отримує `PoolTimeoutError` → `503 {"error":"service busy, try again"}` (`app/src/server.js:65`). Це і є «Сервіс зайнятий» на екрані. Найбільше постраждав `/pickup`: він бере з'єднання тричі за запит (`app/src/parcels.js:61-67`).
4. **Чому все відновилося саме тоді.** Перезапуск о 14:20 підняв ту саму v1.8.0 з тим самим compose, тому пул знову був 4. Відкат на v1.7.3 о 14:47 повернув compose з `DB_POOL_MAX: "20"`, і за хвилину `in_use` піднявся до 14, а `waiting` впав до 0.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | Реліз v1.8.0 перейменував змінну пулу в compose обох сервісів | `grep -n 'DB_POOL' incident/changes/v1.8.0.diff` | `86:-  DB_POOL_MAX: "20"`, `87:+  DB_POOL_SIZE: "20"`, те саме в рядках 106–107 |
| 2 | Код читає лише `DB_POOL_MAX`, за замовчуванням 4, а `DB_POOL_SIZE` ніде не читає | `grep -rn 'DB_POOL' app/src` | `app/src/config.js:9: dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,` і `:10` для `DB_POOL_WAIT_MS`; `DB_POOL_SIZE` — 0 збігів |
| 3 | Черга до пулу була рівно у вікні v1.8.0 і ніколи інакше | `awk -F, 'NR>1 && $6>0 {n++; if(!f)f=substr($1,12,5); l=substr($1,12,5)} END{print n, f, l}' incident/metrics/2026-10-14.csv` | `45 14:02 14:46`: 45 хвилин, саме з деплою до відкату |
| 4 | Коли була черга, пул упирався саме в 4 | `awk -F, 'NR>1 && $6>0 && $5!=4' incident/metrics/2026-10-14.csv \| wc -l` | `0`: у кожну хвилину з чергою `in_use` = 4 |
| 5 | За звичайного дня черги до пулу немає взагалі, пік з'єднань 13 | `awk -F, 'NR>1 && $6>0' incident/baseline/metrics-2026-10-13.csv \| wc -l`; `awk -F, 'NR>1 {if($5>m)m=$5} END{print m}' incident/baseline/metrics-2026-10-13.csv` | `0`; `13` |
| 6 | Усі 503 — тайм-аут пулу, і лише у вікні v1.8.0. За звичайного дня їх немає | `grep -c '"error":"db pool wait timeout after 2000ms"' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl`; `grep 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl \| cut -c19-26 \| sed -n '1p;$p'` | `3380` і `0`; `14:02:07` … `14:46:58` |
| 7 | Трафік у вікні інциденту такий самий, як того ж часу 13.10, тобто причина не в навантаженні | `metric incident/metrics/2026-10-14.csv rps 14:02 14:47`; `metric incident/baseline/metrics-2026-10-13.csv rps 14:02 14:47` | `rps 14:02-14:47 avg 11.80 max 12.8`; `rps 14:02-14:47 avg 11.85 max 12.5` |
| 8 | Вплив: p95 і частка 5xx у вікні проти базового дня | `metric incident/metrics/2026-10-14.csv p95_ms 14:02 14:47`; `metric incident/baseline/metrics-2026-10-13.csv p95_ms 14:02 14:47`; `metric incident/metrics/2026-10-14.csv error_rate 14:02 14:47`; `metric incident/baseline/metrics-2026-10-13.csv error_rate 14:02 14:47` | `p95_ms … avg 4476.16 max 4962` проти `avg 236.13 max 255`; `error_rate … avg 0.11 max 0.1347` проти `avg 0.00 max 0.0069` |
| 9 | Постраждали насамперед видачі посилок | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | `2586 /pickup`, `650 /parcels`, `144 /admin/parcels` |
| 10 | Перезапуск о 14:20 — та сама версія, тому не допоміг | `grep '"service started"' incident/logs/api-2026-10-14.jsonl \| grep -o '"ts":"[^"]*"\|"version":"[^"]*"'` | `14:02:00 1.8.0`, `14:20:31 1.8.0`, `14:47:00 1.7.3` |
| 11 | Відновлення збігається з відкатом до хвилини | `awk -F, 'NR>1 && substr($1,12,5)>="14:46" && substr($1,12,5)<="14:48"' incident/metrics/2026-10-14.csv` | 14:46: `in_use 4, waiting 17, p95 4697`; 14:47: `14, 0, 618`; 14:48: `11, 0, 296` |
| 12 | Механізм відтворюється в коді: пул `max: 4` при зайнятих з'єднаннях кидає `PoolTimeoutError`, а handler мапить її на 503 | `grep -n 'PoolTimeoutError' app/src/db.js app/src/server.js` | `db.js`: `reject(new PoolTimeoutError(waitMs))`; `server.js:65`: `[503, { error: "service busy, try again" }]` |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| **SMS-провайдер душить нас 429** (чергова, 14:10; алерт 13:37) | Алерт за пів години до інциденту, тисячі `rate limited` у логах worker-а | 429 — щоденний фон: хвилин із `sms_429_per_min > 0` `awk -F, 'NR>1 && $8>0' incident/metrics/2026-10-14.csv \| wc -l` → `94`, у 13.10 (`awk -F, 'NR>1 && $8>0' incident/baseline/metrics-2026-10-13.csv \| wc -l`) → `95`. Записів `rate limited`: `grep -c 'rate limited' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `3065` / `2935`. З 13:28 до 14:01 429 вже були, а p95 тримався ~236 мс: `metric incident/metrics/2026-10-14.csv p95_ms 13:30 14:02` → `avg 235.94 max 262`. Worker має окремий пул: `grep -n 'createPool' app/src/server.js app/src/worker.js` → окремий `createPool` у кожному (`server.js:91`, `worker.js:43`). І окремий процес: api і worker стартують у різний час і з різною кількістю перезапусків, `grep -h -o -E '"ts":"[^"]*","level":"info","msg":"[a-z]+ started"' incident/logs/api-2026-10-14.jsonl incident/logs/worker-2026-10-14.jsonl` → api: 14:02:00, 14:20:31, 14:47:00; worker: 14:02:07, 14:47:01. Перезапуск api о 14:20 worker не зачепив |
| **Провайдер «почав глючити раніше» — TLS timeout о 14:01:37** (чергова, 14:14) | Подія за 23 с до першої помилки | Одна-єдина за день і така сама є в звичайному дні: `grep -c 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `1` / `1`. API до SMS-провайдера не звертається: `grep -n 'sms' app/src/server.js` → 0 збігів |
| **Витік пам'яті в API: heap 81 %** (чергова, 14:12) | `heap usage high` у логах у розпал інциденту | Звичайна картина: `grep -c '"heap usage high"' incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `63` / `70`. `metric incident/metrics/2026-10-14.csv heap_used_pct 14:02 14:47` → `avg 65.16 max 82`; `metric incident/baseline/metrics-2026-10-13.csv heap_used_pct 14:02 14:47` → `avg 68.82 max 82`, тобто в інцидент навіть нижче, ніж звичайно. Після рестарту heap падає: `awk -F, 'NR>1 && substr($1,12,5)>="14:01" && substr($1,12,5)<="14:02" {print $1, $7}' incident/metrics/2026-10-14.csv` → `76` → `42` |
| **Пікове навантаження** (моя гіпотеза) | Інцидент саме в післяобідній пік | `metric incident/metrics/2026-10-14.csv rps 14:02 14:47` → `avg 11.80 max 12.8`, а 13.10 `metric incident/baseline/metrics-2026-10-13.csv rps 14:02 14:47` → `avg 11.85 max 12.5`. При цьому 13.10 черги до пулу не було: `awk -F, 'NR>1 && $6>0' incident/baseline/metrics-2026-10-13.csv \| wc -l` → `0` |
| **Баг `sender.trim()` → 500 на `/parcels`** (обидва прогони AI згадали) | Це 5xx, і їх видно в логах | Почався задовго до деплою і триває після відкату: `grep trim incident/logs/api-2026-10-14.jsonl \| cut -c19-23 \| sed -n '1p;$p'` → `12:39`, `15:57`. Після відкату (з 14:47): `grep trim incident/logs/api-2026-10-14.jsonl \| cut -c19-23 \| awk '$1>="14:47"' \| wc -l` → `22`. Скільки й з яким статусом: `grep -c trim incident/logs/api-2026-10-14.jsonl` → `125`; `grep trim incident/logs/api-2026-10-14.jsonl \| grep -o '"status":[0-9]*' \| sort \| uniq -c` → `125 "status":500`, тобто `500`, а не `503`, проти 3380 тайм-аутів пулу (доказ 6). Щодня: `grep -c trim incident/baseline/api-2026-10-13.jsonl` → `128` |
| **Реліз зламав текст SMS або worker** (зміни v1.8.0 у `worker.js`) | Диф торкався worker-а | Змінено лише текст SMS і назву лог-повідомлення (`incident/changes/v1.8.0.diff`). Worker після 14:02 шле пачки як звичайно: `grep '"sms batch sent"' incident/logs/worker-2026-10-14.jsonl \| cut -c19-20 \| sort \| uniq -c` → `323 12`, `306 13`, `279 14`, `334 15`, а 13.10 (`grep '"sms batch sent"' incident/baseline/worker-2026-10-13.jsonl \| cut -c19-20 \| sort \| uniq -c`) → `322 12`, `300 13`, `272 14`, `328 15`. Саме у вікні v1.8.0: `grep '"sms batch sent"' incident/logs/worker-2026-10-14.jsonl \| cut -c19-23 \| awk '$1>="14:02" && $1<"14:47"' \| wc -l` → `211` проти `205` того ж часу 13.10 (та сама команда по `incident/baseline/worker-2026-10-13.jsonl`), тобто провалу немає |
| **Сам сервіс «лежав»** | Пейджі на 5xx | Процес жив і відповідав: `metric incident/metrics/2026-10-14.csv error_rate 14:02 14:47` → `avg 0.11 max 0.1347`, тобто ~89 % запитів оброблено. У логах API безперервно є успішні вибіркові записи: `grep '"msg":"request"' incident/logs/api-2026-10-14.jsonl \| grep -c '"ts":"2026-10-14T14:[0-4]'` → `317` (логується кожен сотий не-5xx, отже ~32 тис. успішних запитів за 14:00–14:49). Те, що `/health` відповідав 200, видно лише з чату (`grep -n '/health' incident/oncall-chat.md` → рядок 14:29), бо `/health` не логується (`grep -c '"/health"' incident/logs/api-2026-10-14.jsonl` → `0`). Що він не торкається БД, видно з коду: `sed -n 37p app/src/server.js` → `if (method === "GET" && path === "/health") return [200, { status: "ok", version }];` |
| **Інша версія тримає з'єднання довше або має витік з'єднань** (альтернатива з `ai-runs/rca-v1.md`) | Без дифу так само пояснило б «полицю» | Диф v1.8.0 не змінює жодного файлу в `app/src` крім тексту SMS у `worker.js` (`grep '^diff' incident/changes/v1.8.0.diff` → `app/README.md`, `app/package.json`, `app/src/worker.js`, `app/test/worker.test.js`, `deploy/compose.yaml`). Код API між версіями однаковий |

## Чинники, що сприяли (contributing factors)

- **Тихі значення за замовчуванням у `app/src/config.js`.** «sensible default for local dev» `|| 4` застосовується й у продакшні, а невідома змінна ніде не реєструється.
- **Нічого не звіряє compose з кодом.** Ні тест, ні `check:deploy`, ні рев'ю не перевіряють, що назви змінних у `deploy/compose.yaml` читає `config.js`. Це виправляє правило `E1` (`docs/postmortem.md`).
- **`/health` не перевіряє залежності.** Compose і моніторинг вважали сервіс здоровим.
- **Фоновий шум алертів і логів.** 429 щодня, бо `SMS_RATE_PER_SEC: "20"` (`deploy/compose.yaml:20,34` у `main`) удвічі вищий за ліміт провайдера 10/с (`materials/vendors/sms-provider.md:16`), плюс `heap usage high` і щоденні 500 на `trim`. Вони дали дві правдоподібні хибні гіпотези і забрали ~40 хв.
- **Деплой у пік** (14:02, післяобідні партії доставки), тому ефект був одразу максимальним.
- **Відкат не був першим кроком,** хоча пейдж прийшов через 4 хв після деплою. Автор релізу оцінив зміни як косметичні (чат, 14:13), і зв'язок «реліз → пейдж» відклали.

## Впевненість

**Висока.** Механізм повністю простежується від дифу (доказ 1) через код (2, 12) до метрик (3–5) і логів (6, 10). Межі вікна збігаються з деплоєм і відкатом до секунд (6, 11), а всі альтернативи спростовано даними за 13.10. Бракує прямого спостереження: у логах немає ефективного розміру пулу при старті, а з контейнера v1.8.0 ніхто не зняв `env`. Висновок змінило б лише те, якби в продакшні `DB_POOL_MAX` задавався ще десь поза compose (`.env` на VM). Але тоді пул не був би 4, а доказ 4 показує саме 4.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | «реліз 1.8.0 → … пул з'єднань з БД майже напевно став значно меншим». Що саме зменшило пул, не знає: «немає ні changelog, ні конфігів, ні диффу» | «перейменував змінну `DB_POOL_MAX` на `DB_POOL_SIZE` у `deploy/compose.yaml`… `config.js:9` досі читає `env.DB_POOL_MAX`… дефолт `\|\| 4`» |
| Впевненість, яку заявив AI | «висока… (близько 90%)» щодо «реліз → вичерпання пулу»; «середня щодо точного механізму» | «висока, приблизно 90–95 %» |
| Збігається з вашою? | **частково**: ланка «реліз → пул 4 → 503» правильна, механізм не встановлено. Пропонує й хибну альтернативу «1.8.0 тримає з'єднання довше / витік» | **так**, до рядка коду |
| Що в даних вплинуло на відповідь | — | `incident/changes/v1.8.0.diff` (видно перейменування) + `app/src/config.js:9` (видно default 4) + `incident/baseline/` (аргумент проти 429 і heap цифрами 13.10). Обидва прогони відкинули 429, TLS, heap і `trim` ще й без baseline, лише з форми метрик. Але v1 подав дрібну вигадку як факт: «worker ретраїть лише 2 рази (400 і 800 мс)». Насправді `maxAttempts = 4` (`app/src/sms.js:14`), просто в логах трапляються лише `attempt` 1–2 (`grep -o '"attempt":[0-9]*' incident/logs/worker-2026-10-14.jsonl \| sort \| uniq -c`). Жоден прогін не помітив, що 429 щодня спричиняє сам compose (`SMS_RATE_PER_SEC: "20"` при ліміті 10/с). v2 бачив compose, але не бачив документа провайдера |
