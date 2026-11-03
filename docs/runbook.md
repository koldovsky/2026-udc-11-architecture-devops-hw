# Runbook: високі latency/5xx та `db_pool_waiting`

Для чергового під час симптомів «сервіс зайнятий» у pickup. Команди — з кореня; production-команди виконувати лише після координації.

- **Alerts:** `ApiLatencyP95High`, `Api5xxRateHigh`, `db_pool_waiting > 0`.
- **Вплив:** `/pickup` і `/parcels` можуть повертати 503, тоді як `/health` може бути 200.

## Перші 5 хвилин

1. `Get-Content incident/alerts.json` — зафіксуйте час і тип alert.
2. `Import-Csv incident/metrics/2026-10-14.csv | Select-Object -Last 20` — p95 > 2000 мс, error rate > 0.05 або waiting > 0 означають деградацію.
3. `$a=Get-Content incident/logs/api-2026-10-14.jsonl|%{$_|ConvertFrom-Json}; $a|? {$_.error -like '*pool wait timeout*'}|select -First 5` — timeout означає виснаження клієнтського пулу, не доводить падіння PostgreSQL.
4. `Select-String -Path app/src/config.js,deploy/compose.yaml -Pattern 'DB_POOL_MAX|DB_POOL_SIZE|DB_POOL_WAIT_MS'` — якщо compose має `DB_POOL_SIZE`, а код читає `DB_POOL_MAX`, restart не допоможе.
5. `Get-Content incident/alerts.json | Select-String 'SmsProvider429|ApiLatency|Api5xx'` — SMS alert до API alert є окремою проблемою; не змішуйте причинність.

## Діагностика

| Питання | Команда | Інтерпретація |
|---|---|---|
| Скільки 503 і чому? | `$a|Group-Object error|sort Count -Descending` | Переважання `db pool wait timeout` → проблема пулу. |
| Чи є інші 500? | `$a|? status -eq 500|select -First 20 ts,path,error` | `trim`/validation — окремий дефект. |
| Чи відрізняється baseline? | `$m=Import-Csv incident/metrics/2026-10-14.csv; $b=Import-Csv incident/baseline/metrics-2026-10-13.csv; [pscustomobject]@{incident=($m.db_pool_waiting|measure -Maximum).Maximum; baseline=($b.db_pool_waiting|measure -Maximum).Maximum}` | 23 проти 0 підтверджує аномалію. |
| Чи відновився rollback? | `Import-Csv incident/metrics/2026-10-14.csv | ? {$_.ts -match '14:47|14:48'} | select ts,p95_ms,error_rate,db_pool_waiting` | Очікуємо wait=0, p95 < 500 мс. |

## Безпечні дії

Rollback: спочатку зафіксувати логи й обрати конкретний заздалегідь схвалений good release; потім виконати rollback через штатну платформу розгортання. Не запускати довільний `docker compose up` без вибору версії образу, бо це може повторити несправний latest.

| Ситуація | Дія | Обмеження |
|---|---|---|
| Після release росте wait | Зупинити rollout і rollback на останній good release. | Не видаляти БД/чергу; не повторювати restart без зміни config. |
| Перевірка конфігурації | `docker compose -f deploy/compose.yaml config | Select-String 'DB_POOL|DB_POOL_WAIT'` | Не виводити `SMS_TOKEN`. |
| SMS 429 | Залишити retry/backoff, ескалувати provider owner. | Не збільшувати rate limit під час інциденту. |
| Підозра на DB | Лише read-only connectivity/lock checks; залучити DBA. | Не restart/kill сесії без доказу. |

## Відновлення

Протягом 10 хвилин: два інтервали з `db_pool_waiting=0`, p95 у baseline або <500 мс, error rate <0.05; немає нових pool timeout; `/health` 200 **і** контрольний pickup повертає бізнес-відповідь, не 503. Перевірити окремо worker/SMS queue.

## Ескалація

- Incident lead/SRE: 5xx >5% три хвилини, wait росте або rollback не дає wait=0 за 5 хв.
- DBA: wait триває при правильному effective pool або є DB locks/connectivity failure.
- Release owner: mismatch env, відсутній startup validation або невдалий rollback.
- SMS provider owner: 429 понад 15 хв, TLS timeout або накопичення невідправленої черги.
