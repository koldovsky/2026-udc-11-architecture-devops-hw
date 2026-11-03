# RCA: інцидент недоступності pickup, 2026-10-14

## Коротко

14 жовтня з 14:02 до rollback о 14:47 API працював із фактичним пулом БД на 4 з'єднання замість очікуваних 20. Причиною була несумісна зміна production-змінної `DB_POOL_MAX` на `DB_POOL_SIZE` у v1.8.0, яку застосунок не читає та тому використав fallback `4`. Черга до пулу спричинила 3380 відповідей 503; після rollback ключові метрики нормалізувалися. Впевненість — висока (95%): прямої телеметрії PostgreSQL немає, але код, diff, часовий зв'язок, симптом і rollback взаємно підтверджують висновок.

## Хронологія (Europe/Kyiv)

| Час | Подія | Доказ |
|---|---|---|
| 13:28–13:37 | Окрема деградація SMS; alert 429 відкрито о 13:37. | `Get-Content incident/metrics/2026-10-14.csv | Select-String '13:28|13:37'` → SMS 2 і 41; `incident/alerts.json` → alert 13:37. |
| 14:01 | API ще близько норми. | `Import-Csv incident/metrics/2026-10-14.csv | ? ts -eq '2026-10-14T14:01:00+03:00'` → p95 245 ms, wait 0. |
| 14:02 | Deploy v1.8.0; пул став 4, почалося очікування. | `Select-String 'v1.8.0' incident/deploys.log` → deploy 14:02; метрика → in_use 4, waiting 4. |
| 14:04–14:07 | p95 виріс до 3.5–4.5 с, error rate до 6.84–11.85%; спрацювали сторінки. | `Import-Csv incident/metrics/2026-10-14.csv | ? {$_.ts -match '14:0[4-7]'} | select ts,p95_ms,error_rate` → ці значення; `incident/alerts.json` → 14:06/14:07. |
| 14:20 | Перезапуск API не змінив проблему. | `incident/deploys.log` → restart v1.8.0; метрика 14:21 → p95 4588 ms, waiting 20. |
| 14:47–14:48 | Rollback v1.7.3; alerts закриті, p95 296 ms, wait 0. | `incident/deploys.log`, `incident/alerts.json`; метрики 14:47/14:48. |

## Першопричина

У diff v1.8.0 production-конфігурацію перейменували з `DB_POOL_MAX` на `DB_POOL_SIZE`. Код `app/src/config.js` читає тільки `env.DB_POOL_MAX` і має fallback `Number(...) || 4`. Обидва контейнери тому стартували з пулом 4. Під навантаженням запити чекали понад `DB_POOL_WAIT_MS=2000`, а `server.js` перетворював `PoolTimeoutError` на 503. Rollback повернув сумісну конфігурацію.

## Докази

> Додаткова перевірка повноти: кількість окремих API 500 також відтворюється командою `$a=Get-Content incident/logs/api-2026-10-14.jsonl|%{$_|ConvertFrom-Json}; ($a|? status -eq 500).Count` і дорівнює `125`. Для обох сервісів diff містить заміну `DB_POOL_MAX` на `DB_POOL_SIZE`; застосунок обох процесів читає `DB_POOL_MAX`. Точний стан PostgreSQL і точний внесок SMS-черги залишаються непідтвердженими через відсутність відповідних логів.

| Твердження | Команда (з кореня) | Фактичний результат |
|---|---|---|
| Код читає `DB_POOL_MAX`, fallback 4. | `Select-String -Path app/src/config.js -Pattern 'dbPoolMax|DB_POOL_MAX|\|\| 4'` | `dbPoolMax: Number(env.DB_POOL_MAX) || 4`. |
| v1.8.0 замінив змінну. | `Select-String -Path incident/changes/v1.8.0.diff -Pattern 'DB_POOL_MAX|DB_POOL_SIZE'` | Видалено `DB_POOL_MAX`, додано `DB_POOL_SIZE`. |
| Після deploy пул став 4. | `Import-Csv incident/metrics/2026-10-14.csv | ? ts -eq '2026-10-14T14:02:00+03:00' | select db_pool_in_use,db_pool_waiting` | `4`, `4`; о 14:01 — `12`, `0`. |
| 503 були timeout пулу. | `$a=Get-Content incident/logs/api-2026-10-14.jsonl|%{$_|ConvertFrom-Json}; [pscustomobject]@{timeouts=($a|? error -like '*pool wait timeout*').Count; status503=($a|? status -eq 503).Count}` | `3380`, `3380`. |
| Rollback відновив API. | `Import-Csv incident/metrics/2026-10-14.csv | ? {$_.ts -match '14:47|14:48'} | select ts,p95_ms,db_pool_waiting` | 14:47: 618/0; 14:48: 296/0. |
| Health не перевіряє pickup. | `Select-String -Path app/src/server.js -Pattern '"/health"|"/pickup"|PoolTimeoutError'` | health повертає 200 окремо; pickup використовує pool; timeout → 503. |

## Альтернативні гіпотези

Команди в цій таблиці виконуються самостійно; твердження про `$a` нижче включають ініціалізацію змінної в тій самій команді.

| Гіпотеза | Відхилення або обмеження |
|---|---|
| SMS-провайдер спричинив API-падіння. | `incident/alerts.json` → SMS alert 13:37, API alerts 14:06/14:07; API відновився rollback-ом. SMS — окрема проблема, внесок у фон не виключений. |
| Витік пам'яті. | `Import-Csv incident/metrics/2026-10-14.csv | ? {$_.ts -match '14:01|14:02|14:12|14:47'} | select ts,heap_used_pct` → 76%, 42%, 81%, 46%. Без heap-профілю не доведено і не спростовано повністю. |
| Несправна PostgreSQL/мережа. | API лог містить pool wait timeout, не connect failure; rollback клієнта відновився. Прямі DB-логи відсутні, тому остаточно виключити неможливо. |
| `trim`-помилка. | `$a|? status -eq 500|group error` → окремі 125 500; вона не пояснює 3380 503 і не є першопричиною. |

## Чинники

- Немає перевірки відповідності env-імен між compose і кодом.
- Production використовує небезпечний fallback 4 без fail-fast та метрики effective config.
- `/health` не перевіряє пул і pickup.
- Окремий SMS-інцидент створив шум під час triage.

## Впевненість

**Висока, 95%.** Є ланцюг diff → fallback → метрика пулу → timeout → rollback. Не підтверджено лише стан PostgreSQL та точний внесок SMS-черги через відсутність DB/provider-side логів.

## Порівняння `rca-v1.md` і `rca-v2.md`

| | v1 | v2 |
|---|---|---|
| Причина | Зв'язок v1.8.0 зі зменшенням пулу; конкретна реалізація приблизна. | Несумісне `DB_POOL_MAX` → `DB_POOL_SIZE`, fallback 4. |
| Впевненість | Близько 70% для механізму. | Близько 95%. |
| Відповідність цьому RCA | Часткова. | Повна. |
| Вплив даних | Alerts, logs, metrics. | Додавання `app/`, `deploy/` і diff показало точний механізм; SMS до deploy і `trim` відокремлено. |
