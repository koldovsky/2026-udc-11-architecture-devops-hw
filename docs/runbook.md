# Runbook: API latency / 5xx з очікуванням пулу БД

- **Алерт(и):** ApiLatencyP95High (p95_ms > 2000 протягом 3 хв), Api5xxRateHigh (error_rate > 0.05 протягом 3 хв). SmsProvider429RateHigh (sms_429_per_min > 20 протягом 5 хв) — окрема проблема worker-а; сам по собі не підтверджує деградацію API. Умови наведені в incident/alerts.json.
- **Що це означає для користувачів:** API повільно відповідає або повертає 503; мешканці можуть не забирати посилки на екрані поштомата.
- **Скільки є часу:** якщо db_pool_waiting росте, запити можуть завершитися тайм-аутом приблизно за 2 секунди (DB_POOL_WAIT_MS у runtime config); починайте діагностику одразу після першого стійкого зростання черги.

## Перші 5 хвилин

1. Підтвердіть alert та часовий пояс Europe/Kyiv; занотуйте час deploy/restart/rollback і версію, але не перезапускайте API, доки не перевірили його effective env.
2. Перевірте обидва сервіси:

   <code>docker compose -f deploy/compose.yaml ps</code>

   Якщо api або worker не Up — збережіть логи та ескалуйте власнику релізу.

3. Перевірте локальний health endpoint:

   <code>curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health</code>

   200 доводить лише, що HTTP API відповідає; цей handler не перевіряє БД.

4. Перевірте error logs та запуск:

   <code>docker compose -f deploy/compose.yaml logs --since=15m api | rg 'db pool wait timeout|service started|request failed' | tail -n 50</code>

   Багато db pool wait timeout після старту — ознака вичерпання пулу. Збережіть часи й версію у #poshtomat-oncall.

## Діагностика

| Питання | Команда | Як читати результат |
|---|---|---|
| Чи накопичуються тайм-аути пулу? | <code>docker compose -f deploy/compose.yaml logs --since=10m api</code> | Шукай рядки db pool wait timeout; повторення разом із метрикою waiting підтверджує DB-pool pressure. |
| Який pool key подає Compose? | <code>rg -n 'DB_POOL_MAX' deploy/compose.yaml app/src/config.js; rg -n 'DB_POOL_SIZE' deploy/compose.yaml</code> | Зістав ключі в Compose з app/src/config.js. Якщо є лише DB_POOL_SIZE, runtime проігнорує його і візьме default 4. |
| Які значення бачить саме API? | <code>docker compose -f deploy/compose.yaml exec -T api printenv DB_POOL_MAX DB_POOL_SIZE</code> | Для коректного конфігу має бути DB_POOL_MAX з погодженим значенням; DB_POOL_SIZE без DB_POOL_MAX — неправильний ключ. Команда показує лише ці дві змінні. |
| Чи відповідає API без доступу до БД? | <code>curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health</code> | 200 — процес HTTP живий; це не доказ здоров'я БД. |
| Чи проходить безпечний read-only запит до БД через API? | <code>printf 'header = "Authorization: Bearer %s"\n' "$STAFF_SESSION" &#124; curl --config - -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/admin/parcels</code> | 200 — маршрут і DB access працюють; 503 — перевірте pool wait; 403 — session невалідна, перевірте токен окремо. Встановіть STAFF_SESSION із менеджера паролів. Конфіг читається curl зі stdin, тож токен не потрапляє до аргументів процесу або виводу; не вмикайте shell tracing. |
| Чи має конфіг правильний ключ у джерелі? | <code>rg -n 'DB_POOL_MAX' deploy/compose.yaml app/src/config.js; rg -n 'DB_POOL_SIZE' deploy/compose.yaml</code> | Назва має збігатися з app/src/config.js. Для цього сервісу це DB_POOL_MAX. |

## Як підтвердити причину

Підтвердженням конфігураційного дефекту є поєднання трьох фактів: API логує db pool wait timeout; runtime має DB_POOL_SIZE, але не DB_POOL_MAX; app/src/config.js читає DB_POOL_MAX із default 4. Для аналізу зафіксованого релізу перевірте diff:

<code>rg -n 'DB_POOL_(MAX|SIZE)' incident/changes/v1.8.0.diff</code>

Якщо diff показує DB_POOL_MAX → DB_POOL_SIZE, це та сама помилка класу, що й у RCA. Перевірте доступність SMS-провайдера окремо; 429 без DB-pool тайм-аутів самі по собі не пояснюють API 503.

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| DB_POOL_MAX відсутня, а є тільки DB_POOL_SIZE | Відновіть конфіг і образ із зафіксованого здорового релізу, а не з рухомої гілки. Візьміть повний commit SHA та image tag/digest із перевіреного release record. Для v1.7.3 спершу знайдіть відповідний commit у deployment history; якщо SHA або образ не підтверджені — не виконуйте rollback, ескалуйте власнику релізу. | Підставити перевірений SHA: <code>ROLLBACK_COMMIT="&lt;full-commit-sha&gt;"; git cat-file -e "${ROLLBACK_COMMIT}^{commit}" &amp;&amp; git show "${ROLLBACK_COMMIT}:deploy/compose.yaml" &gt; deploy/compose.rollback.yaml</code>; перевірити ключі: <code>rg -n 'DB_POOL_MAX' deploy/compose.rollback.yaml; rg -n 'DB_POOL_SIZE' deploy/compose.rollback.yaml</code> | Переконайтесь, що SHA відповідає затвердженому Compose та незмінному image tag/digest із того самого релізу; зафіксуйте обидва посилання перед застосуванням. |
| Перевірені Compose та image tag готові до застосування | Пересоздайте обидва сервіси з образом відомого релізу. | <code>IMAGE_NAME="&lt;verified-image-name&gt;" IMAGE_TAG="&lt;verified-immutable-tag&gt;" docker compose -f deploy/compose.rollback.yaml up -d --no-deps api worker</code> | Контейнери перезапустяться; перевірте версію, effective env, logs, очікування пулу та read-only admin-запит. |
| Після застосування правильного ключа ще є тайм-аути | Перевірте DB connectivity / стан БД та зверніться до власника БД; не піднімайте pool вище погодженої межі без перевірки DB capacity. | <code>docker compose -f deploy/compose.yaml logs --since=10m api</code> | Підвищення ліміту без перевірки може перевантажити PostgreSQL; зберігайте фактичні error messages для ескалації. |
| API усе ще має 5xx і вплив росте | Використайте лише зафіксований Compose commit і перевірений image tag/digest з останнього здорового релізу; після відкату повторіть перевірки зверху. | <code>IMAGE_NAME="&lt;verified-image-name&gt;" IMAGE_TAG="&lt;verified-immutable-tag&gt;" docker compose -f deploy/compose.rollback.yaml up -d --no-deps api worker</code> | Переконайтесь, що запущена очікувана версія, DB_POOL_MAX не відсутня і невідомий DB_POOL_SIZE не є єдиним ключем. |
| Є лише SmsProvider429RateHigh, DB pool wait та API 5xx відсутні | Перевірте worker logs і конфіг швидкості; ескалуйте провайдеру за його процесом, не робіть rollback API лише через 429. | <code>docker compose -f deploy/compose.yaml logs --since=10m worker</code> | Шукай sms provider rate limited або sms send failed. Повідомлення можуть затримуватися; не збільшуйте SMS_RATE_PER_SEC без перевірки квоти провайдера. |

## Коли ескалювати і кого кликати

- DB-pool тайм-аути або 5xx тривають після виправленого redeploy — власника БД та інженера бекенду в #poshtomat-oncall.
- Вплив на мешканців триває або rollback не повернув метрики — власника релізу та чергового керівника; координуйте статус із гарячою лінією.
- Є лише 429 від SMS-провайдера — відповідального за інтеграцію SMS; додайте часові інтервали і кількість відповідей 429, не додавайте токен або номер телефону до повідомлення.

## Як переконатися, що все гаразд

- <code>curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health</code> повертає 200.
- Read-only <code>GET /admin/parcels</code> з валідною сесією повертає 200.
- Метрики p95 нижче 2,000 мс, error_rate нижче 0.05, db_pool_waiting дорівнює 0 щонайменше п'ять хвилин.
- <code>docker compose -f deploy/compose.yaml logs --since=5m api</code> не показує нових db pool wait timeout.
- Записані у #poshtomat-oncall версія, час відновлення і перевірені значення DB_POOL_MAX; секрети не публікуються.
