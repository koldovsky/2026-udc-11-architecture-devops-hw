# Runbook: API повільний або віддає 5xx (`ApiLatencyP95High`, `Api5xxRateHigh`)

- **Алерт(и):**
  - `ApiLatencyP95High` — `p95_ms > 2000` протягом 3 хв (page);
  - `Api5xxRateHigh` — `error_rate > 0.05` протягом 3 хв (page);
  - супутній, сам по собі **не** привід будити: `SmsProvider429RateHigh` — `sms_429_per_min > 20`
    протягом 5 хв (warning). Він спрацьовує щодня в післяобідній пік (див. `docs/rca.md`,
    «Що НЕ є причиною»).
- **Що це означає для користувачів:** екран поштомата після введення коду пише «Сервіс
  зайнятий, спробуйте пізніше» (`503`, `app/src/server.js:65`) — люди не можуть забрати
  посилки; сканер служби доставки не може зареєструвати посилку; адмінка не відкривається.
- **Скільки є часу:** вплив уже є, коли прийшов page. Гаряча лінія починає отримувати дзвінки
  за кілька хвилин; 14.10.2026 від першої помилки до відновлення минуло 45 хв — ціль
  відновити за ≤ 15 хв.

> **Важливо:** `GET /health` відповідає `200`, навіть коли API не має з'єднань з БД —
> він не ходить у базу (`app/src/server.js:37`). «Health зелений» нічого не доводить.

Команди нижче виконуються на VM (`ssh poshtomat-prod-1`) з теки репозиторію, де лежить
`deploy/compose.yaml`.

## Перші 5 хвилин

1. Напишіть у #poshtomat-oncall: «Взяв(ла) `<алерт>`, дивлюся». Так друга людина знає, що
   робити нічого не треба, поки ви не покличете.
2. **Чи був деплой або зміна конфігу за останні 2 години?** Це найчастіша причина і
   найшвидший фікс.
   ```bash
   docker compose -f deploy/compose.yaml ps --format 'table {{.Service}}\t{{.Status}}\t{{.CreatedAt}}'
   curl -s http://localhost:8080/health          # {"status":"ok","version":"<версія>"}
   git log -3 --format='%h %ci %s' -- deploy app
   ```
   Контейнер створено нещодавно / версія новіша, ніж учора → переходьте одразу до «Що робити»,
   рядок 1 (відкат). Розбиратися будемо після.
3. Подивіться, **яку саме помилку** віддає API:
   ```bash
   docker compose -f deploy/compose.yaml logs api --since 10m | grep '"level":"error"' \
     | grep -o '"error":"[^"]*"' | sort | uniq -c | sort -rn | head
   ```
   - `db pool wait timeout after …ms` — API чекає вільного з'єднання з базою → «Діагностика».
   - Інше повідомлення → «Коли ескалювати».

## Діагностика

| Питання | Команда | Як читати результат |
|---|---|---|
| Скільки запитів падають на пулі БД і на яких ендпоінтах? | `docker compose -f deploy/compose.yaml logs api --since 10m \| grep 'db pool wait timeout' \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | Десятки на хвилину на `/pickup`, `/parcels`, `/admin/parcels` — пул вичерпано. Поодинокі — шукайте далі. |
| Який розмір пулу реально отримав API? | `docker compose -f deploy/compose.yaml exec api printenv \| grep '^DB_POOL'` | Має бути `DB_POOL_MAX=20` (`deploy/compose.yaml:16`). Немає `DB_POOL_MAX` або інша назва (`DB_POOL_SIZE`…) → API працює з дефолтом **4** (`app/src/config.js:9`). Це і є причина. |
| Скільки з'єднань зайнято / скільки чекає? | метрики `db_pool_in_use`, `db_pool_waiting` на дашборді за останні 30 хв | `in_use` рівно стоїть на одному числі (4, 20…) і `waiting > 0` — пул менший за навантаження. `in_use` низький, а `waiting > 0` не буває — тоді дивіться саму БД. |
| Чи жива сама PostgreSQL? | `sudo -u postgres psql -d poshtomat -c 'select count(*) from pg_stat_activity;'` | Відповідь за секунду — БД жива, проблема в пулі застосунку. Висить / помилка → «Коли ескалювати». |
| Чи не нічне вікно бекапу? | `date '+%H:%M'` | 02:00–02:30 — база блокує запис (`docs/ops/backup-runbook.md:10-11`); чекайте до 02:30, дивіться `sudo tail -n 5 /var/log/poshtomat/backup.log`. |
| Чи справді винен SMS-провайдер? | `docker compose -f deploy/compose.yaml logs worker --since 10m \| grep -c 'sms provider rate limited'` | Будь-яке число тут **не** пояснює 503 на `/pickup`: worker шле SMS поза з'єднанням з БД (`app/src/worker.js:19-24`) і в іншому процесі. 429 щодня в пік — норма. |
| Чи не пам'ять? | `docker compose -f deploy/compose.yaml logs api --since 30m \| grep -c 'heap usage high'` | Попередження `heap usage high` (≥ 75 %) — щоденний фон, 13.10 без інциденту їх було 70. Причина — лише якщо контейнер перезапускається з OOM (`docker compose ps` показує `Restarting`). |

## Як підтвердити причину

Причина «замалий пул після зміни конфігу» підтверджена, коли **разом**:
1. `printenv` в контейнері API не показує `DB_POOL_MAX=20` (рядок 2 таблиці вище);
2. `db_pool_in_use` з моменту деплою стоїть рівно на одному значенні, а `db_pool_waiting > 0`.

Якщо `DB_POOL_MAX=20` на місці, а пул однаково забитий — це не конфіг: дивіться довгі запити в
БД (`pg_stat_activity`) і ескалюйте.

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| 1. Був деплой за останні 2 год | Відкотити на попередню версію (образ **і** `deploy/compose.yaml`) | `git checkout <попередній-тег> -- deploy app && docker compose -f deploy/compose.yaml up -d --build` | Відкат конфігу разом з кодом — інакше помилкова змінна лишиться. Через 2 хв: `curl -s localhost:8080/health` показує стару версію, `p95` < 500 мс. |
| 2. Змінна пулу відсутня або з іншою назвою, відкат неможливий | Повернути `DB_POOL_MAX: "20"` для `api` і `worker` у `deploy/compose.yaml` | `docker compose -f deploy/compose.yaml up -d api worker` | Перевірити `printenv` (як у «Діагностиці»); через 2 хв `db_pool_waiting` = 0. |
| 3. Пул правильний, БД жива, запити просто довгі | Не перезапускати навмання; зібрати `pg_stat_activity` | `sudo -u postgres psql -d poshtomat -c "select pid, now()-query_start as dur, state, left(query,80) from pg_stat_activity order by dur desc limit 10;"` | Ескалювати другому розробнику з цим виводом. |
| Будь-яка | **Не** перезапускати API як «першу допомогу» | — | Рестарт перечитує ту саму конфігурацію; 14.10 він не допоміг (`incident/deploys.log:8`), а лише забрав 4 хв. |

## Коли ескалювати і кого кликати

- Через 15 хв без покращення або якщо не підходить жоден рядок «Що робити» → другий розробник
  (не черговий цього тижня) у #poshtomat-oncall і дзвінком.
- БД не відповідає або падає з помилками → власник `docs/ops/backup-runbook.md` (розробник
  з інфраструктури).
- Користувачі не можуть забрати посилки понад 30 хв у робочий час → повідомте координаторку
  проєкту, щоб гаряча лінія мала текст для мешканців.

## Як переконатися, що все гаразд

- `p95_ms` < 500 мс і `error_rate` < 0,01 три хвилини поспіль; пейджі закриваються самі.
- `db_pool_waiting` = 0, `db_pool_in_use` знову коливається з навантаженням (не «прилип» до
  одного числа).
- У лозі API немає нових `db pool wait timeout`:
  `docker compose -f deploy/compose.yaml logs api --since 3m | grep -c 'db pool wait timeout'` → `0`.
- Напишіть у #poshtomat-oncall, що зроблено і о котрій; занотуйте час для post-mortem.
