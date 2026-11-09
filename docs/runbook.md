# Runbook: затримка API / 5xx на видачі посилок

- **Алерти:** `ApiLatencyP95High` (`p95_ms > 2000` протягом 3 хв) і `Api5xxRateHigh` (`error_rate > 0.05` протягом 3 хв); умови: `rg -n -e 'ApiLatencyP95High' -e 'Api5xxRateHigh' -e 'condition' incident/alerts.json`.
- **Вплив:** поштомат може показувати «Сервіс зайнятий, спробуйте пізніше» та не видавати посилку; API також може відмовляти в реєстрації. Помилки 503 на `/pickup` є прямим сигналом впливу. Доказ механізму — [RCA](rca.md), рядки 5–6 таблиці доказів.
- **Час на реакцію:** почніть діагностику одразу; у цьому інциденті пейджі з'явилися через 4–5 хв після перших 503 (`rg -n 'fired_at' incident/alerts.json` і хронологія RCA).

Команди `docker compose` нижче виконуйте **на production VM** із теки, де є активний `deploy/compose.yaml`. Перед змінами звірте, що це потрібний хост і реліз. Команди з `incident/` — для тренування або ретроспективи з кореня цього репо. Не виводьте в канал чергування всі змінні оточення чи токени.

## Перші 5 хвилин

1. Зафіксуйте початок і перевірте стан контейнерів: `date -Is` і `docker compose -f deploy/compose.yaml ps`. Якщо `api` не працює, перейдіть до відновлення контейнера й ескалації; якщо працює, продовжіть.
2. Перевірте реальний симптом: `docker compose -f deploy/compose.yaml logs --since=5m api | grep -c '"path":"/pickup","status":503'`. Додатне число означає, що видача відмовляє; відсутність збігів сама по собі не доводить здоров'я, перевірте загальні 5xx та p95 у моніторингу. Не запускайте тестовий `/pickup` з реальним кодом: він змінює стан посилки.
3. Перевірте `/health`: `curl -fsS http://localhost:8080/health`. `200` і `status:ok` означають лише живий HTTP-процес; `/health` не звертається до БД (`rg -n 'GET.*health' app/src/server.js` у репо). Запишіть версію з відповіді.
4. Подивіться на повідомлення 503: `docker compose -f deploy/compose.yaml logs --since=5m api | grep -m 3 'db pool wait timeout after'`. Якщо є тайм-аут пулу, перевірте ефективний конфіг і останній реліз. Якщо немає, не застосовуйте гілку про пул автоматично — ескалуйте до власника API з логами та метриками.

## Діагностика

| Питання | Команда на production VM | Як читати результат |
|---|---|---|
| Чи працює API-контейнер? | `docker compose -f deploy/compose.yaml ps api` | `running` → переходьте до логів; `exited`/відсутній → перевірте `docker compose -f deploy/compose.yaml logs --tail=100 api` і кличте власника релізу. |
| Скільки 503 і чи саме це пул? | `docker compose -f deploy/compose.yaml logs --since=5m api \| grep -c '"status":503'` | Додатне число → активний вплив; `db pool wait timeout after` у кроці 4 → гілка пулу. Нуль збігів → звірте p95/error rate в моніторингу; `grep` може завершитися кодом 1. |
| Який ефективний ліміт пулу, без друку секретів? | `docker compose -f deploy/compose.yaml exec -T api node --input-type=module -e 'import {loadConfig} from "./src/config.js"; console.log(JSON.stringify({dbPoolMax:loadConfig().dbPoolMax,dbPoolWaitMs:loadConfig().dbPoolWaitMs,hasDbPoolMax:"DB_POOL_MAX" in process.env,hasDbPoolSize:"DB_POOL_SIZE" in process.env}))'` | `dbPoolMax:4`, `hasDbPoolMax:false`, `hasDbPoolSize:true` → імовірна несумісність ключів; правильний ліміт беріть із затвердженої конфігурації, не вгадуйте. |
| Який ключ у Compose активного релізу? | `grep -n -e 'DB_POOL_MAX' -e 'DB_POOL_SIZE' deploy/compose.yaml` | `DB_POOL_SIZE` замість `DB_POOL_MAX` в API/worker → причина класу 2026-10-14; зіставте з `app/src/config.js`. |
| Чи є незалежний SMS-сигнал? | `docker compose -f deploy/compose.yaml logs --since=5m worker \| grep -c '"status":429'` | Додатне число → SMS проблема також існує; не пояснює автоматично 503 API. Порівняйте час і пул. |

Якщо доступний моніторинг, поруч відкрийте `rps`, `p95_ms`, `error_rate`, `db_pool_in_use`, `db_pool_waiting` за останні 15 хвилин і позначте час деплою. У навчальному наборі відтворення: `rg '^2026-10-14T14:0[125]:' incident/metrics/2026-10-14.csv` → після релізу `db_pool_in_use=4`, черга `4→20`, p95 `245→4565` мс при близькому rps. Метрика `db_pool_in_use` показує використання, а не сама по собі налаштований максимум; зіставляйте її з ефективним конфігом.

## Як підтвердити причину

1. У контейнері перевірте ефективні `dbPoolMax`, `hasDbPoolMax`, `hasDbPoolSize` командою з таблиці. Збіг `4 / false / true` відрізняє неправильне ім'я змінної від простого стрибка трафіку.
2. Підтвердіть тайм-аути пулу в API-логах і часовий збіг із релізом. Для цього інциденту: `rg '2026-10-14T14:02:' incident/deploys.log` → v1.8.0; `rg -m 1 '"status":503' incident/logs/api-2026-10-14.jsonl` → 14:02:07, `db pool wait timeout after 2000ms`; `rg -n -e 'DB_POOL_MAX' -e 'DB_POOL_SIZE' incident/changes/v1.8.0.diff` → перейменування в обох сервісах.
3. Якщо ефективний ліміт правильний, але є тайм-аути, перевірте стан БД з власником БД; цей runbook не встановлює причину такого випадку.

## Що робити

| Ситуація | Дія та команда на production VM | Ризик / перевірка |
|---|---|---|
| Підтверджено саме `DB_POOL_SIZE` замість `DB_POOL_MAX`; затверджене значення — 20. | Збережіть конфіг: `cp deploy/compose.yaml /tmp/compose-before-pool-fix.yaml`. На Linux VM виправте ключ в обох сервісах: `sed -i 's/DB_POOL_SIZE:/DB_POOL_MAX:/' deploy/compose.yaml`. Перевірте: `grep -n -e 'DB_POOL_MAX' -e 'DB_POOL_SIZE' deploy/compose.yaml` → два `DB_POOL_MAX`, жодного `DB_POOL_SIZE`. Перезапустіть API: `docker compose -f deploy/compose.yaml up -d --no-deps --no-build --force-recreate api`. Зафіксуйте тимчасову зміну та відкрийте релізний fix. | Перезапуск API перерве поточні запити. Перевірте ефективний `dbPoolMax=20` командою з таблиці, логи й метрики нижче. Worker оновіть за процедурою релізу. Якщо ключ відрізняється від цього сценарію, не застосовуйте `sed`. |
| Причина інша або затверджене значення пулу невідоме. | `docker compose -f deploy/compose.yaml logs --tail=100 api` → збережіть діагностику; ескалюйте відповідальному за релізи й власнику API, за потреби власнику БД. | Не змінюйте навмання ліміт пулу чи `DATABASE_URL`; надмірний пул може перевантажити БД. |
| Після виправлення 503 залишилися. | `docker compose -f deploy/compose.yaml logs --since=5m api \| grep -m 5 '"status":503'` | Якщо є нові 503 або p95/error rate не відновилися, ескалюйте як активний інцидент; перевірте фактичну версію й конфіг контейнера. |

## Коли ескалювати і кого кликати

- Є 503 `/pickup` і немає підтвердженого способу відновлення → відповідальний за релізи та власник API негайно.
- Ефективний `DB_POOL_MAX` правильний, але пул чекає чи БД недоступна → власник API та черговий БД.
- SMS 429 тривають після відновлення API → власник SMS-інтеграції як окремий інцидент.
- Після виправлення 503 або висока затримка зберігаються понад 5 хв → інцидентний канал і керівник чергування.

## Як переконатися, що все гаразд

1. `curl -fsS http://localhost:8080/health` → очікувана версія; пам'ятайте, що це лише перевірка процесу.
2. `docker compose -f deploy/compose.yaml logs --since=5m api | grep -c '"status":503'` → 0 нових збігів (код `grep` 1 означає відсутність збігів); перевірте також, що немає нових `db pool wait timeout after`.
3. У моніторингу протягом щонайменше 5 хвилин перевірте `db_pool_waiting=0`, p95 нижче 2000 мс, error rate нижче 5% за порівнянного rps; дочекайтеся закриття обох API-алертів. Для прикладу інциденту: `rg '^2026-10-14T14:4[678]:' incident/metrics/2026-10-14.csv` → після відкату черга 0 і p95 296 мс о 14:48.
4. Повідомте підтримку поштоматів про відновлення та продовжуйте окремо відстежувати SMS warning.
