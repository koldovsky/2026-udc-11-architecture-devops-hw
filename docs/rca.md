# RCA: API 503 через вичерпання пулу БД, 2026-10-14

## Коротко

Приблизно 14:05–14:50 частина мешканців не могла забрати посилки й бачила «Сервіс зайнятий». Реліз v1.8.0 перейменував змінну DB_POOL_MAX на DB_POOL_SIZE, якої застосунок не читає; через це API використав default у 4 з'єднання замість налаштованих 20, і запити почали чекати пул понад 2 секунди та отримували 503. Відкат до v1.7.3 відновив стару назву змінної й нормальну роботу пулу.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (команда → результат) |
|---|---|---|
| 13:37 | Алерт SmsProvider429RateHigh; API latency та error rate ще звичайні. | <code>rg -n -C 2 'SmsProvider429RateHigh' incident/alerts.json</code> → контекст alert із часом fired о 13:37 |
| 14:01:37 | Worker записав одиничний TLS timeout до SMS-провайдера. | <code>rg -n 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl</code> → один запис о 14:01:37.954 |
| 14:02 | Розгорнуто v1.8.0; API перезапустився з цією версією. | <code>rg -n '2026-10-14T14:02' incident/deploys.log incident/logs/api-2026-10-14.jsonl</code> → deploy v1.8.0 та service started о 14:02:00 |
| 14:02–14:03 | Зайнятість API-пулу падає з 12 до 4; очікування зростає з 0 до 10, p95 — 2,446 мс. | <code>rg -n '2026-10-14T14:01:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:02:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:03:00' incident/metrics/2026-10-14.csv</code> → рядки 14:01–14:03 |
| 14:06–14:08 | Спрацювали latency та 5xx alerts; гаряча лінія підтвердила помилки видачі. | <code>rg -n '14:06' incident/oncall-chat.md; rg -n '14:07' incident/oncall-chat.md; rg -n '14:08' incident/oncall-chat.md</code> → два page-и, далі повідомлення про «Сервіс зайнятий» |
| 14:20–14:24 | Перезапустили лише API на v1.8.0; p95 знову перевищив 4 секунди, 503 тривали. | <code>rg -n '14:20' incident/oncall-chat.md; rg -n '14:24' incident/oncall-chat.md; rg -n '2026-10-14T14:20' incident/deploys.log incident/logs/api-2026-10-14.jsonl</code> → restart v1.8.0 та повідомлення «не допомогло» |
| 14:29 | /health повертав 200, хоча API-запити до БД завершувались 503. | <code>rg -n '14:29' incident/oncall-chat.md</code> → повідомлення про 200; <code>rg -n 'path === "/health"' app/src/server.js</code> → health route не звертається до DB |
| 14:47 | Відкат до v1.7.3; метрика показує 14 активних з'єднань і 0 очікувачів. | <code>rg -n '2026-10-14T14:47' incident/deploys.log incident/logs/api-2026-10-14.jsonl incident/metrics/2026-10-14.csv</code> → rollback і старт v1.7.3, db_pool_waiting=0 |
| 14:48–14:50 | Alerts закрилися, p95 опустився нижче 300 мс; у чаті повідомили, що 503 немає. | <code>rg -n '14:48' incident/alerts.json; rg -n '14:50' incident/oncall-chat.md</code> → alert resolved і повідомлення про відновлення |

## Першопричина

1. У початковому Compose пул задавали як DB_POOL_MAX=20. У diff v1.8.0 ключ перейменовано на DB_POOL_SIZE=20 для api і worker. Застосунок читає лише env.DB_POOL_MAX і підставляє 4, якщо змінної немає (app/src/config.js:9).
2. API передає це значення у пул (app/src/server.js:89-93). Пул допускає не більше max одночасних зайнятих з'єднань (app/src/db.js:63-79). Коли всі чотири зайняті, наступні запити стоять у черзі; після 2 секунд пул кидає PoolTimeoutError (app/src/db.js:72-79). Сервер перетворює цю помилку на HTTP 503 з текстом «service busy» (app/src/server.js:63-68).
3. Навантаження не було незвичним: 13 жовтня між 14:00–15:00 середній RPS був 11.647, максимум 12.8, без жодного db_pool_waiting; 14 жовтня — середній 11.627 і той самий максимум 12.8. Але після deploy 14 жовтня пул обмежився 4 з'єднаннями, p95 піднявся до 4,962 мс, error rate — до 13.47%, очікування — до 23.
4. Перезапуск v1.8.0 о 14:20 завантажив ті самі некоректні змінні, тож не допоміг. Rollback v1.7.3 повернув DB_POOL_MAX=20; у 14:47 очікувачів уже не було, а p95 впав до 618 мс, далі — до 296 мс.

Таким чином, SMS 429 та TLS timeout були паралельними проблемами worker-а, але API 503 спричинив невідповідний ключ пулу в Compose.

## Докази

| # | Твердження | Команда (з кореня репо, Git Bash) | Результат |
|---|---|---|---|
| 1 | Користувачі не могли забрати посилки приблизно 45 хвилин. | <code>rg -n -A 1 '14:05' incident/README.md</code> | incident/README.md:3–4 → вікно 14:05–14:50 і опис впливу. |
| 2 | SMS 429 alert передував двом API page-ам. | <code>node -e 'const a=JSON.parse(require("fs").readFileSync("incident/alerts.json","utf8")); for(const x of a.alerts) console.log(x.name,x.fired_at,x.resolved_at)'</code> | SmsProvider429RateHigh 13:37–15:03; ApiLatencyP95High 14:06–14:48; Api5xxRateHigh 14:07–14:48. |
| 3 | У v1.8.0 Compose перейменував ключ, а app читає старий ключ із default 4. | <code>rg -n 'DB_POOL_MAX' incident/changes/v1.8.0.diff app/src/config.js; rg -n 'DB_POOL_SIZE' incident/changes/v1.8.0.diff</code> | Diff видаляє DB_POOL_MAX=20 і додає DB_POOL_SIZE=20 для обох сервісів; app/src/config.js:9 читає DB_POOL_MAX і має default 4. |
| 4 | Тайм-аут пулу безпосередньо стає 503. | <code>rg -c 'db pool wait timeout' incident/logs/api-2026-10-14.jsonl; rg -n 'PoolTimeoutError' app/src/server.js app/src/db.js; rg -n 'service busy' app/src/server.js; rg -n 'dbPoolMax' app/src/config.js</code> | Інцидентний лог містить 3,380 DB-pool timeout; app/src/db.js кидає помилку, app/src/server.js повертає 503 (рядок 65), config.js має default 4 (рядок 9). |
| 5 | Після deploy місткість знизилась, а черга виросла. | <code>rg -n '2026-10-14T14:01:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:02:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:03:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:05:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:06:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:46:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:47:00' incident/metrics/2026-10-14.csv; rg -n '2026-10-14T14:48:00' incident/metrics/2026-10-14.csv</code> | 14:01 in_use=12 waiting=0; 14:02 4/4; 14:03 4/10; 14:05 4/20; 14:06 4/19; 14:46 4/17; 14:47 14/0 and 429/min=40; 14:48 11/0 and 429/min=36. |
| 6 | Основні 503 — саме тайм-аути пулу; 2,586 припали на видачу. | <code>node -e 'const a=require("fs").readFileSync("incident/logs/api-2026-10-14.jsonl","utf8").trim().split(String.fromCharCode(10)).map(JSON.parse).filter(x=&gt;x.msg==="request failed"); const c={}; for(const x of a){const k=x.status+" "+x.path+" "+x.error;c[k]=c[k]?c[k]+1:1} console.log(a.length,c)'</code> | 3,505 request failed: 650 /parcels, 2,586 /pickup, 144 /admin/parcels з 503 db pool wait timeout after 2000ms; ще 125 /parcels помилок sender.trim(). |
| 7 | Трафік 14 жовтня не перевищив здоровий baseline 13 жовтня. | <code>node -e 'const fs=require("fs"); for(const p of ["incident/baseline/metrics-2026-10-13.csv","incident/metrics/2026-10-14.csv"]){const [h,...r]=fs.readFileSync(p,"utf8").trim().split(String.fromCharCode(10)),k=h.split(",");const a=r.map(s=&gt;Object.fromEntries(s.split(",").map((v,i)=&gt;[k[i],i?+v:v]))).filter(x=&gt;x.ts.slice(11,16)&gt;="14:00"&amp;&amp;x.ts.slice(11,16)&lt;"15:00");console.log(p,"avg_rps",(a.reduce((s,x)=&gt;s+x.rps,0)/a.length).toFixed(3),"max_rps",Math.max(...a.map(x=&gt;x.rps)),"max_p95",Math.max(...a.map(x=&gt;x.p95_ms)),"max_error",Math.max(...a.map(x=&gt;x.error_rate)),"max_wait",Math.max(...a.map(x=&gt;x.db_pool_waiting)),"avg_429",(a.reduce((s,x)=&gt;s+x.sms_429_per_min,0)/a.length).toFixed(2),"max_heap",Math.max(...a.map(x=&gt;x.heap_used_pct)))}</code> | 13 жовтня: avg_rps 11.647, max_rps 12.8, max_p95 260, max_error 0.0069, max_wait 0, avg_429 32.35, max_heap 82; 14 жовтня: 11.627, 12.8, 4962, 0.1347, 23, 34.45, 82. |
| 8 | v1.8.0 стартував о 14:02, рестарт о 14:20 не змінив версію, rollback о 14:47 повернув v1.7.3. | <code>rg -n 'service started' incident/logs/api-2026-10-14.jsonl; rg -n 'shutting down' incident/logs/api-2026-10-14.jsonl</code> | 14:02 service started v1.8.0; 14:20 shutdown/start v1.8.0; 14:46:58 shutdown і 14:47 service started v1.7.3. |
| 9 | SMS 429 були й напередодні, і після відновлення API; TLS timeout був одиничним. | <code>rg -c '"msg":"sms provider rate limited"' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl</code> і <code>rg -n 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl</code> | 3,065 429 логів 14 жовтня та 2,935 13 жовтня; один TLS timeout о 14:01:37.954. |
| 10 | Високий heap не є специфічним для інциденту. | <code>node -e 'const fs=require("fs"); for(const p of ["incident/baseline/metrics-2026-10-13.csv","incident/metrics/2026-10-14.csv"]){const a=fs.readFileSync(p,"utf8").trim().split(String.fromCharCode(10)).slice(1).map(s=&gt;s.split("," )).filter(x=&gt;x[0].slice(11,16)&gt;="14:00"&amp;&amp;x[0].slice(11,16)&lt;"15:00"); console.log(p,Math.max(...a.map(x=&gt;+x[6])))}</code> | max heap_used_pct=82 і 13, і 14 жовтня. |
| 11 | Помилки sender.trim() існували до релізу. | <code>node -e 'const fs=require("fs"); for(const p of ["incident/baseline/api-2026-10-13.jsonl","incident/logs/api-2026-10-14.jsonl"]){const a=fs.readFileSync(p,"utf8").trim().split(String.fromCharCode(10)).map(JSON.parse); console.log(p,a.filter(x=&gt;x.msg==="request failed"&amp;&amp;x.error?.includes("trim")).length)}</code> | 128 таких 500 у baseline; 125 у день інциденту. |
| 12 | /health не перевіряє пул або БД. | <code>rg -n '14:29' incident/oncall-chat.md; rg -n 'path === "/health"' app/src/server.js</code> | On-call повідомив про 200 о 14:29; health повертає {status:"ok"} на server.js:37 до DB-коду. |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS-провайдер спричинив API 503. | SMS 429 alert спрацював раніше, worker мав багато 429 і один TLS timeout. | Докази #7 і #9: 429 були близькі до baseline і тривали після rollback; API 503 містять db pool wait timeout, а розбіжність DB_POOL_SIZE/DB_POOL_MAX збігається з падінням пулу. Це окрема проблема затримки SMS. |
| Витік пам'яті / високий heap. | У чаті згадали heap usage high, значення досягали 81–82%. | Доказ #10: максимум 82% був і напередодні за справної API latency; у метриках немає унікального для інциденту росту. |
| TLS timeout на SMS спричинив падіння. | Зафіксований безпосередньо перед deploy. | Доказ #9: це один worker log о 14:01:37; DB-pool 503 почалися після deploy і охопили /pickup, /parcels, /admin/parcels. |
| Некоректний payload без sender спричинив усі 503. | POST /parcels повертав 500 з помилкою trim. | Докази #6 і #11: 128 таких помилок були в baseline проти 125 у день інциденту; основна хвиля — 3,380 інших DB-pool 503, зокрема 2,586 на /pickup. |

## Чинники, що сприяли (contributing factors)

- Compose приймав невідому застосунку змінну без перевірки контракту; помилкова назва непомітно активувала default 4.
- Не було alert-а на db_pool_waiting; перші пейджі були загальними latency/5xx alerts.
- /health повертав 200 без звернення до БД, тому не показував реальну деградацію залежності.
- SMS 429 і згадка heap відволікали увагу; restart API без зміни конфігу повторно завантажив той самий ліміт.
- Є окрема стала помилка валідації sender на /parcels; вона додає шуму в error logs, але не спричинила цей інцидент.

## Впевненість

**Висока.** Diff змінює саме ключ пулу; app/src/config.js підтверджує, що нова назва ігнорується й default — 4; метрики показують рівно 4 зайняті з'єднання та чергу одразу після deploy; API логи містять DB-pool timeout; rollback відновив місткість і latency. Альтернативні сигнали (429, TLS, heap, sender validation) або існували раніше, або не збігаються з механізмом 503. Production адаптер PostgreSQL не лежить у цій теці, але runtime-метрики та повідомлення тайм-ауту відповідають конфігураційному ланцюгу.

## Перша відповідь AI проти другої

| | ai-runs/rca-v1.md — alerts, logs, metrics в ізольованій сесії | ai-runs/rca-v2.md — весь incident/ + app/ + початкові deploy/ в окремій ізольованій сесії |
|---|---|---|
| Що AI назвав першопричиною | Регрес API v1.8.0, пов'язаний із виснаженням пулу БД; лише за цими даними точну зміну коду чи конфігурації не визначити. | Перейменування `DB_POOL_MAX` на `DB_POOL_SIZE` у релізі при коді, що читає лише `DB_POOL_MAX`; унаслідок цього спрацював default 4. |
| Впевненість, яку заявив AI | Висока щодо зв'язку з v1.8.0, середня щодо механізму. | Висока за сукупністю diff, коду, метрик і відкату; фактичного знімка env контейнера в доказах немає. |
| Збігається з вашою? | Частково — вгадав механізм і ліміт, не міг підтвердити причину. | Так. |
| Що в даних вплинуло на відповідь | API/worker логи та метрики інциденту; baseline, release diff і конфіг-код не були доступні. | `incident/changes/v1.8.0.diff`, початковий `deploy/compose.yaml`, `app/src/config.js`, перезапуск/rollback і baseline `incident/baseline/`. |
