- Інструмент і модель: Claude Code, Claude Opus 5.5
- Дата: 2026-11-04
- Що бачила сесія:
  - Промпт 1: тимчасова тека `ws11-c2` з копією `incident/`, `app/`, `deploy/` (вміст ідентичний репо).
  - Промпт 2: ті самі файли в репо, а також `docs/rca.md`, `docs/walkthrough.md`, `ai-runs/README.md`, `AGENTS.md`, `CLAUDE.md`, `materials/vendors/sms-provider.md` і `ai-runs/rca-v1.md`.
  - Отже, Частина 1 написана **без** знання `rca-v1.md` і `materials/`, а Частина 2 — вже з ними.
- Промпт 1, розслідування (дослівно):

  > Ти — черговий інженер сервісу «Поштомат громади». 14 жовтня 2026 року спрацювали алерти.
  >    У теці — усе, що є про цей інцидент. Що сталося і чому? Назви першопричину,
  >    наскільки ти впевнений і на які дані спираєшся.
  >    Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  >    припущення називай явно.

- Промпт 2, оформлення (дослівно):

  > Compose/populate(
  >   docs/rca.md (шаблон є): хронологія; першопричина; таблиця доказів
  >      «твердження → команда → результат» — кожен рядок можна повторити з кореня репо;
  >      що з даних НЕ є причиною — і чим це доведено: кожна причина, яку назвав хоч один
  >      прогін AI і яку ви відкинули, і те, що підозрювали ви самі; чинники, що сприяли;
  >      впевненість.
  >   )  rca-v2.md based on template /Users/vlad/Projects/rbi_ai_training/hw/2026-udc-11-architecture-devops-hw/docs/rca.md and put into /Users/vlad/Projects/rbi_ai_training/hw/2026-udc-11-architecture-devops-hw/ai-runs folder

Файл має дві частини. Частина 1 — перша відповідь на промпт 1, дослівно, як вимагає
`ai-runs/README.md`. Частина 2 — відповідь на промпт 2, тобто пізніше оформлення за шаблоном,
а не перша відповідь. Команди й результати Частини 2 перевірено запуском із кореня репо
2026-11-04 (macOS, не Git Bash). Позначки `<заповнює учасник>` — те, чого AI не може знати сам.

---

# Частина 1: перша відповідь на промпт 1 (дослівно)

## Verdict

**Root cause: release v1.8.0 accidentally cut the API's database connection pool from 20 to 4.** The "config cleanup" (#212) renamed `DB_POOL_MAX` to `DB_POOL_SIZE` in `deploy/compose.yaml`, but `app/src/config.js:9` still reads `DB_POOL_MAX`. The diff doesn't touch `config.js`, so the variable came back empty and the code silently used its local-dev default of 4.

At peak traffic the API had been using 12–13 connections. With only 4 available, requests queued, and any that waited over 2 s got a 503, which the locker screen showed as "Service busy".

**Confidence: high, about 95%.** The evidence is strong but indirect: nothing in the folder records the pool size the running process actually used, such as a container env dump or a startup log line.

## Timeline (14 Oct)

| Time | Event |
|---|---|
| 13:28 | SMS 429s begin, as they do on a normal day |
| 13:37 | `SmsProvider429RateHigh` warning fires |
| 14:01:37 | One TLS timeout in the worker, a coincidence |
| 14:02:00 | API starts on v1.8.0 at near-peak traffic |
| 14:02:07 | **First 503** |
| 14:06–14:07 | Latency and 5xx pages fire |
| 14:20:31 | API restart doesn't help: same config, and 503s continue |
| 14:46:58 | **Last 503** |
| 14:47:00 | API starts on v1.7.3 after the rollback; pool use immediately reaches 14 |
| 15:01 | SMS 429s fade out, 14 minutes after recovery |

The real impact window was **14:02:07–14:46:58**, a little wider than the README's "about 14:05–14:50".

## Evidence

- **The config failure reproduces:** on a scratch copy with the diff applied, `DB_POOL_MAX=20` gives a pool of 20 and `DB_POOL_SIZE=20` gives 4.
- **The pool hits a hard limit:** `db_pool_in_use` is exactly 4 in all 45 minutes of the window, against an average of 11.8 at the same time on 13 Oct.
- **Requests queue:** `db_pool_waiting` averages 17 and peaks at 23, against 0 on 13 Oct.
- **Every 503 has the same cause:** all 3,380 say `db pool wait timeout after 2000ms`, with none before the deploy, after the rollback, or on 13 Oct.
- **Failure times match the code:** each endpoint's longest 503 fits how many connections it takes, each with its own 2 s limit.

| Endpoint | Connections taken | Longest 503 |
|---|---|---|
| `/parcels` | 1 | 2,008 ms |
| `/admin/parcels` | 2 | 3,882 ms |
| `/pickup` | 3 | 5,607 ms |

- **Load didn't change:** traffic was 11.80 rps against 11.85 on 13 Oct, so the same demand met less capacity.
- **Deploy and rollback act as an on/off switch:** the fault starts 7 s after the deploy and ends at the rollback, while SMS 429s and traffic carry on unchanged.

**Impact:** about 10.6% of all requests failed during the window. That includes 2,586 pickups, roughly 13% of attempts (estimated from the 1% log sample), and 650 parcel registrations. Successful pickups also slowed, with a median of about 2.5 s against 71 ms.

## Other explanations I ruled out

| Theory | Why it doesn't hold |
|---|---|
| SMS provider throttling | 13 Oct had the same 429s (2,935 vs 3,065) and met the same alert condition at 13:36, with no outage. The API doesn't use `sms.js`, and the worker sends SMS outside any DB connection. SMS sent didn't drop (8,655 vs 8,265 in the window), and the provider reported no incidents. |
| TLS timeout at 14:01:37 | It happened once, and 13 Oct had one too (13:12:45). It's in the worker, and being first in time doesn't make it the cause. |
| Memory leak | The heap follows the same 54–82% cycle on both days, and the 81% seen at 14:12 is normal. There are no out-of-memory errors. The 14:20 restart dropped the heap to about 42%, but 503s continued. |
| Traffic spike | Traffic was the same as the day before. |
| `sender.trim` 500 errors | This is a real bug, but it predates the release (125 vs 128 errors) and is unrelated. |
| PostgreSQL | There are no DB logs, so this is only indirectly excluded. Usage sat exactly at the limit rather than varying, and it recovered as soon as the pool was restored. |

## Possible data damage still to check

`pickup()` takes separate connections to find the parcel, mark it `picked_up`, and write the event, with no transaction. If the third step times out, the resident sees a 503 but the parcel is already marked as picked up. I reproduced this on the scratch copy: the status became `picked_up`, no event was written, and a retry returned "not found" (a 404 from the API).

- **Likely scale:** at least **205** `/pickup` 503s lasted over 4,020 ms, which is only possible if the failure came at the third step. The true number may be higher.
- **Consequence:** the nightly expiry job only looks at `waiting` parcels, so these could stay stuck in their cells.
- **What the logs show:** 404s didn't visibly rise (30 vs 33), but a 1% sample is too coarse to rule this out.
- **What to do:** query for parcels marked `picked_up` between 14:02 and 14:47 with no matching event.

## Assumptions

- Production ran the `compose.yaml` from the diff. The `app/` and `deploy/` folders are at v1.7.3, so I applied the diff to get v1.8.0.
- Production's PostgreSQL layer behaves like the in-memory `db.js`, including the pool and the lack of a transaction in `pickup()`. The damage estimate depends on this most.
- `docs/ARCHITECTURE.md` is out of date (v1.5), so I relied on the code instead.

## Why it got through

- **Silent fallback:** `|| 4` turns a missing production setting into a local-dev value without any warning.
- **Tests don't cover it:** all 15 tests pass with the diff applied, because none compare `compose.yaml` with `config.js`.
- **Easy to miss in review:** alphabetising the variables reshuffled the whole block and hid the one rename.
- **Poor visibility:** `/health` never touches the DB, so it returned 200 throughout, and nothing logs the pool size at startup.
- **Misleading alert:** the routine 429 warning, which also met its condition on 13 Oct, pulled the investigation toward SMS.

## Before releasing again

1. Use one variable name in both `compose.yaml` and `config.js`.
2. Make the service refuse to start in production if a required setting is missing, and log the pool size at startup.
3. Alert on `db_pool_waiting`.
4. Make `pickup()` a single transaction.

I didn't change anything in the project. The repro used a patched copy and two helper scripts in the session's temporary scratchpad, so no report files were created.

---

# Частина 2: RCA за шаблоном `docs/rca.md` (відповідь на промпт 2)

# RCA: інцидент 2026-10-14

## Коротко

З 14:02:07 до 14:46:58 (близько 45 хв) частина мешканців не могла забрати посилки: екран
поштомата показував «Сервіс зайнятий, спробуйте пізніше», бо 10,6 % запитів до API
завершувалися помилкою 503. Причина — реліз v1.8.0 перейменував у `deploy/compose.yaml`
змінну `DB_POOL_MAX` на `DB_POOL_SIZE`, а код і далі читав стару назву, тож пул з'єднань
із БД мовчки зменшився з 20 до типового для локальної розробки значення 4. Сервіс відновив
відкат на v1.7.3 о 14:47, хоча на той момент причину ще не встановили.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 13:28 | Перші 429 від SMS-провайдера. Це щоденний фон пікової години: 13.10 вони почалися о 13:24 | `grep '^2026-10-14T13:28' incident/metrics/2026-10-14.csv` |
| 13:37 | Попередження `SmsProvider429RateHigh` | `grep -n 'fired_at' incident/alerts.json` |
| 13:40 | Чергова бачить, що SMS доходять, і свідомо не втручається | `grep -n '13:40' incident/oncall-chat.md` |
| 14:01:37 | Один TLS-таймаут у worker-а, ще до розгортання | `grep 'TLS handshake' incident/logs/worker-2026-10-14.jsonl` |
| 14:02:00 | API стартує на v1.8.0; нотатка релізу — «config cleanup» | `grep 'v1.8.0' incident/deploys.log` |
| 14:02:07 | **Перша 503**, через 7 с після старту; тієї ж секунди стартує worker v1.8.0 | `grep -m1 '"status":503' incident/logs/api-2026-10-14.jsonl` |
| 14:06 | Пейдж `ApiLatencyP95High` | `grep -n 'fired_at' incident/alerts.json` |
| 14:07 | Пейдж `Api5xxRateHigh` | `grep -n 'fired_at' incident/alerts.json` |
| 14:08 | Чергова бере інцидент; гаряча лінія повідомляє про екран «Сервіс зайнятий» | `grep -n '14:08' incident/oncall-chat.md` |
| 14:10–14:14 | Робочі версії: SMS-провайдер, пам'ять. Автор релізу описує реліз як несуттєвий, а TLS-таймаут трактують як доказ, що проблема почалася до розгортання | `grep -nE '14:1[0-4]' incident/oncall-chat.md` |
| 14:17 | Звернення до підтримки SMS-провайдера | `grep -n '14:17' incident/oncall-chat.md` |
| 14:20:31 | Перезапуск лише API на тій самій v1.8.0 | `grep 'restart' incident/deploys.log` |
| 14:21 | Heap 42 %, але помилки повернулися: `error_rate` 0,1068 | `grep '^2026-10-14T14:21' incident/metrics/2026-10-14.csv` |
| 14:29 | `/health` увесь час відповідає 200 | `grep -n '14:29' incident/oncall-chat.md` |
| 14:36 | Провайдер: інцидентів у них немає | `grep -n '14:36' incident/oncall-chat.md` |
| 14:46:58 | **Остання 503**; цієї ж секунди API зупиняється для відкату | `awk '/"status":503/{l=$0} END{print l}' incident/logs/api-2026-10-14.jsonl` |
| 14:47:00 | API стартує на v1.7.3 | `grep 'rollback' incident/deploys.log` |
| 14:47 | Пул знову понад 4: `db_pool_in_use` 14, `db_pool_waiting` 0, p95 618 мс | `grep '^2026-10-14T14:47' incident/metrics/2026-10-14.csv` |
| 14:48 | Обидва пейджі закрито | `grep -n 'resolved_at' incident/alerts.json` |
| 14:50 | Сервіс здоровий, причину ще не знайдено | `grep -n '14:50' incident/oncall-chat.md` |
| 15:01 | Останні 429 (метрики) — через 14 хв після відновлення API | `grep '^2026-10-14T15:01' incident/metrics/2026-10-14.csv` |
| 15:03 | Попередження про 429 закрито | `grep -n 'resolved_at' incident/alerts.json` |

## Першопричина

**Реліз v1.8.0 змінив назву змінної оточення лише з одного боку.** Ланцюжок:

1. **Що змінилося.** Під час сортування змінних за алфавітом у `deploy/compose.yaml` рядок
   `DB_POOL_MAX: "20"` став `DB_POOL_SIZE: "20"` (докази 1, 3).
2. **Що стало інакше.** `app/src/config.js:9` читає лише `DB_POOL_MAX`:
   `Number(env.DB_POOL_MAX) || 4`. Змінна стала порожньою, спрацював запасний варіант, тому
   пул зменшився з 20 до 4 без жодної помилки чи рядка в лозі (докази 2, 4, 5).
3. **Чому це вдарило одразу.** Розгортання припало на пік: раніше API в цей час займав до
   13 з'єднань, а тепер мав лише 4 (докази 6, 7). Трафік при цьому не змінився (доказ 11).
4. **Чому користувачі побачили саме цей екран.** Запит чекає на з'єднання не довше 2 с, потім
   отримує `PoolTimeoutError`, а `app/src/server.js:65` перетворює її на 503
   `service busy, try again`. Усі 3380 відповідей 503 мають саме цю причину (докази 8, 9).
5. **Чому постраждала лише частина.** Пул — обмеження на одночасність, а не повна відмова.
   Запити, що встигали отримати з'єднання за 2 с, проходили, але повільно (докази 12, 15).
6. **Чому перезапуск не допоміг.** Він підняв той самий реліз із тим самим оточенням, тож
   пул знову мав 4 з'єднання (докази 13, 14).
7. **Чому відкат допоміг.** v1.7.3 повернув `DB_POOL_MAX: "20"`. У першу ж хвилину пул
   зайняв 14 з'єднань, а черга зникла (докази 6, 7).

Worker отримав такий самий пул на 4, але він працює послідовно, тож не впирався в ліміт
(доказ 19).

## Докази

Виконайте один раз у сесії Git Bash, з кореня репо — це статистика колонки метрик за проміжок:

```bash
win() { awk -F, -v c="$2" -v a="$3" -v b="$4" 'NR==1{for(i=1;i<=NF;i++)if($i==c)k=i;next} {t=substr($1,12,5)} t>=a&&t<b{v=$k+0;s+=v;n++;if(n==1||v<l)l=v;if(v>m)m=v} END{printf "%s %s-%s avg %.3f min %s max %s\n",c,a,b,s/n,l,m+0}' "$1"; }
```

У таблиці `\|` означає звичайний `|` (так екрановано для Markdown). Команди читають
`app/` і `deploy/` у стані з початку домашки, тобто до змін Task D.

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | Реліз перейменував змінну пулу для обох сервісів | `grep -n 'DB_POOL' incident/changes/v1.8.0.diff` | рядки 86–87 і 106–107: `-DB_POOL_MAX: "20"`, `+DB_POOL_SIZE: "20"` |
| 2 | Код читає лише стару назву | `grep -n 'DB_POOL' app/src/config.js` | `9: dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4`; `10: dbPoolWaitMs: ...` |
| 3 | Реліз не змінював `config.js` | `grep -c 'src/config.js' incident/changes/v1.8.0.diff` | `0` |
| 4 | Нової назви код не знає: зі `DB_POOL_SIZE=20` пул дорівнює 4 | `node --input-type=module -e "import {loadConfig as c} from './app/src/config.js'; console.log(c({DB_POOL_MAX:'20'}).dbPoolMax, c({DB_POOL_SIZE:'20'}).dbPoolMax)"` | `20 4` |
| 5 | Іншого джерела значення в образі немає | `grep -c 'DB_POOL' deploy/Dockerfile` | `0` |
| 6a | У вікні інциденту пул зайнятий рівно на 4 щохвилини | `win incident/metrics/2026-10-14.csv db_pool_in_use 14:02 14:47` | `avg 4.000 min 4 max 4` |
| 6b | За пів години до релізу використання було втричі вищим | `win incident/metrics/2026-10-14.csv db_pool_in_use 13:30 14:02` | `avg 11.531 min 10 max 13` |
| 6c | Попереднього дня в той самий час — так само | `win incident/baseline/metrics-2026-10-13.csv db_pool_in_use 14:02 14:47` | `avg 11.822 min 10 max 13` |
| 6d | Після відкату обмеження зникло | `win incident/metrics/2026-10-14.csv db_pool_in_use 14:47 15:00` | `avg 11.000 min 10 max 14` |
| 7a | Черга до пулу виникла лише в цьому вікні | `win incident/metrics/2026-10-14.csv db_pool_waiting 14:02 14:47` | `avg 17.311 min 4 max 23` |
| 7b | До релізу черги не було | `win incident/metrics/2026-10-14.csv db_pool_waiting 12:00 14:02` | `avg 0.000 min 0 max 0` |
| 7c | Після відкату черги не було | `win incident/metrics/2026-10-14.csv db_pool_waiting 14:47 16:00` | `avg 0.000 min 0 max 0` |
| 7d | Попереднього дня черги не було взагалі | `win incident/baseline/metrics-2026-10-13.csv db_pool_waiting 12:00 16:00` | `avg 0.000 min 0 max 0` |
| 8a | Відповідей 503 за 14.10 | `grep -c '"status":503' incident/logs/api-2026-10-14.jsonl` | `3380` |
| 8b | Усі вони мають одну причину | `grep -c 'db pool wait timeout after 2000ms' incident/logs/api-2026-10-14.jsonl` | `3380` |
| 8c | 13.10 відповідей 503 не було | `grep -c '"status":503' incident/baseline/api-2026-10-13.jsonl` | `0` |
| 8d | Усі 503 лежать між першою і останньою хвилиною v1.8.0 | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| cut -c19-26 \| sed -n '1p;$p'` | `14:02:07`, `14:46:58` |
| 9 | Найдовша 503 відповідає кількості з'єднань, які бере запит (2 с очікування на кожне): `/parcels` — 1, `/admin/parcels` — 2, `/pickup` — 3 | `awk -F'"ms":' '/"status":503/{split($2,a,",");match($1,/"path":"[^"]*"/);p=substr($1,RSTART+7,RLENGTH-7);n[p]++;if(a[1]+0>m[p])m[p]=a[1]+0} END{for(p in n)print p,n[p],"max_ms",m[p]}' incident/logs/api-2026-10-14.jsonl \| sort` | `"/admin/parcels" 144 max_ms 3882`; `"/parcels" 650 max_ms 2008`; `"/pickup" 2586 max_ms 5607` |
| 10 | Звідки ця кількість з'єднань: окремі `withConnection` у коді | `grep -n 'withConnection' app/src/parcels.js app/src/server.js` | `/pickup`: `parcels.js:61,64,67`; `/parcels`: `parcels.js:43`; `/admin/parcels`: `server.js:18` + `parcels.js:74` |
| 11a | Трафік у вікні інциденту | `win incident/metrics/2026-10-14.csv rps 14:02 14:47` | `avg 11.802 min 11 max 12.8` |
| 11b | Трафік 13.10 у той самий час — такий самий | `win incident/baseline/metrics-2026-10-13.csv rps 14:02 14:47` | `avg 11.849 min 11 max 12.5` |
| 12a | p95 зріс приблизно у 20 разів | `win incident/metrics/2026-10-14.csv p95_ms 14:04 14:47` | `avg 4605.488 min 3270 max 4962` |
| 12b | p95 до релізу | `win incident/metrics/2026-10-14.csv p95_ms 13:30 14:02` | `avg 235.938 min 208 max 262` |
| 12c | Частка 5xx під час інциденту | `win incident/metrics/2026-10-14.csv error_rate 14:04 14:47` | `avg 0.112 min 0.0676 max 0.1347` |
| 13 | Перезапуск скинув heap, але не повернув пул: `in_use` лишився 4, помилки тривали | `grep -E '^2026-10-14T14:(19\|20\|21\|22)' incident/metrics/2026-10-14.csv` | `in_use` 4 у всіх рядках; heap 81→43→42→49; `error_rate` 0.1233→0.0676→0.1068→0.1201 |
| 14 | Після перезапуску 503 стало більше, ніж до нього (за довше вікно) | `awk 'substr($0,19,8)>="14:02:00" && substr($0,19,8)<"14:20:31" && /"status":503/{a++} substr($0,19,8)>="14:20:31" && /"status":503/{b++} END{print a,b}' incident/logs/api-2026-10-14.jsonl` | `1290 2090` |
| 15a | Оцінка за метриками: близько 31 866 запитів і 3432 помилки 5xx, тобто 10,8 %; з них 503 — 3380, або 10,6 % | `awk -F, 'NR>1 && substr($1,12,5)>="14:02" && substr($1,12,5)<"14:47"{t+=$2*60;e+=$2*60*$4} END{printf "%.0f %.0f\n",t,e}' incident/metrics/2026-10-14.csv` | `31866 3432` |
| 15b | Логи сходяться з метриками: 3432 рядки `error` (503 + `trim`-помилки) | `awk 'substr($0,19,5)>="14:02" && substr($0,19,5)<"14:47" && /"level":"error"/{n++} END{print n}' incident/logs/api-2026-10-14.jsonl` | `3432` |
| 15c | Оцінка для видачі: 168 × 100 ≈ 16 800 запитів без 5xx (лог — вибірка 1 %) проти 2586 відмов, тобто близько 13 % спроб | `awk 'substr($0,19,5)>="14:02" && substr($0,19,5)<"14:47" && /"path":"\/pickup"/ && /"msg":"request"/{n++} END{print n}' incident/logs/api-2026-10-14.jsonl` | `168` |
| 16 | Тести цю помилку не ловлять: реліз застосовано до тимчасової копії, усі тести зелені, а в `compose.yaml` — нова назва | `d=$(mktemp -d) && cp -r app deploy "$d" && patch -s -d "$d" -p1 < incident/changes/v1.8.0.diff && (cd "$d/app" && npm test 2>&1 \| grep -E '^# (pass\|fail)'); grep -c 'DB_POOL_SIZE' "$d/deploy/compose.yaml"; rm -rf "$d"` | `# pass 15`, `# fail 0`, `2` |
| 17 | Побічний ризик: якщо `pickup()` впаде на третьому з'єднанні, посилка вже `picked_up`, події немає, а повторне введення коду дає «не знайдено». Відтворено заглушкою над кодом `app/` | `node --input-type=module -e "import {createPool,createStore,PoolTimeoutError} from './app/src/db.js'; import {createParcels} from './app/src/parcels.js'; const s=createStore(),r=createPool({max:20,waitMs:2000,store:s});let n=0,f=0; const p=createParcels({pool:{withConnection:(fn)=>++n===f?Promise.reject(new PoolTimeoutError(2000)):r.withConnection(fn)}}); const x=await p.registerParcel({lockerId:1,recipientPhone:'+380000000001',sender:'s'});const code=s.findParcel(x.id).code; n=0;f=3;await p.pickup(code).catch((e)=>console.log(e.message));f=0; console.log(s.findParcel(x.id).status,s.listEvents().length,await p.pickup(code));"` | `db pool wait timeout after 2000ms`; `picked_up 0 null` |
| 18 | Масштаб ризику з доказу 17: 503 довше за 4020 мс можлива лише на третьому з'єднанні (двох очікувань мало), тож таких посилок щонайменше близько 205. **Це оцінка, а не підтверджений факт** | `awk -F'"ms":' '/"status":503/ && /"path":"\/pickup"/{split($2,a,",");if(a[1]+0>4020)n++} END{print n}' incident/logs/api-2026-10-14.jsonl` | `205` |
| 19 | Worker не постраждав від пулу на 4: жодних згадок пулу чи збоїв раунду | `grep -c -E 'pool\|notify round failed' incident/logs/worker-2026-10-14.jsonl` | `0` |
| 20 | Реліз не містить жодного доданого чи видаленого рядка, пов'язаного зі з'єднаннями | `grep -cE '^[-+].*(withConnection\|acquire\|release\|createPool\|findWaitingByCode\|updateParcel)' incident/changes/v1.8.0.diff` | `0` |
| 21 | У `src/` реліз змінив лише текст SMS і текст одного лог-повідомлення | `awk '/^diff --git/{f=$3} /^[-+][^-+]/ && f ~ /src/' incident/changes/v1.8.0.diff` | 4 рядки: `arrivalText` (−/+) і `log.error("sms send failed"` → `"sms delivery failed"` (−/+) |
| 22 | `parcels.js` реліз не змінював, тож три з'єднання на `/pickup` були і у v1.7.3 | `grep -c 'src/parcels.js' incident/changes/v1.8.0.diff` | `0` |
| 23 | **Відкрите питання з `rca-v1.md`:** за 73,5 мс на запит 4 з'єднання обробили б близько 54 rps, а фактична пропускна здатність означає близько 0,38 с утримання | `awk -F, 'NR>1 { t=substr($1,12,5); if (t>="14:02" && t<"14:47") { o+=$2*(1-$4); k++ } } END { r=o/k; printf "ok_rps=%.2f implied_hold=%.2fs capacity_at_73.5ms=%.0f_rps\n", r, 4/r, 4/0.0735 }' incident/metrics/2026-10-14.csv` | `ok_rps=10.53 implied_hold=0.38s capacity_at_73.5ms=54_rps` |
| 24 | Водночас у звичайний день пікова потреба становить близько 0,85 з'єднання на 1 rps, тобто ліміт 4 досягається приблизно за 4,7 rps | `awk -F, 'NR>1{s+=$5/$2;n++} END{printf "mean in_use/rps=%.3f\n",s/n}' incident/baseline/metrics-2026-10-13.csv` | `mean in_use/rps=0.853` |

## Що з даних НЕ є причиною — і чим це доведено

Звідки взято версії:

- **`rca-v1.md` назвав:** 429 і повторні спроби, сплеск трафіку, пам'ять, `trim`, TLS-таймаут,
  завислий процес, витік з'єднань, worker як джерело, проблему на боці БД, другий чинник у
  релізі, масове надходження посилок як джерело сплеску SMS.
- **Цей прогін (v2) назвав:** тротлінг SMS-провайдера, TLS-таймаут, витік пам'яті, сплеск
  трафіку, `trim`, PostgreSQL.
- **Чат чергових:** провайдер SMS, пам'ять, TLS-таймаут.
- **Додано для повноти:** текст SMS, холодний старт, окремі поштомати.

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS-провайдер душить нас через 429, і через це падає API | Найгучніший сигнал: перший алерт, тисячі рядків у лозі | **Той самий обсяг напередодні без збою:** `awk -F, 'NR>1{s+=$8} END{print s}' incident/metrics/2026-10-14.csv` → `3065`; те саме для `incident/baseline/metrics-2026-10-13.csv` → `2935`. **Той самий момент умови алерту (5 хв поспіль > 20):** `awk -F, 'NR>1{if($8+0>20)r++;else r=0; if(r==5 && !f){print substr($1,12,5);f=1}}' incident/baseline/metrics-2026-10-13.csv` → `13:36` (для 14.10 теж `13:36`). **API не використовує SMS:** `grep -c -i 'sms' app/src/server.js` → `0`. **429 тривали після відновлення API:** `win incident/metrics/2026-10-14.csv sms_429_per_min 14:47 15:01` → `avg 32.000 min 14 max 45`. |
| 429 блокують з'єднання БД у worker-а і так виснажують пул | Спільна PostgreSQL, повторні спроби worker-а можуть бути довгими | Worker і API — окремі процеси з окремими пулами, а SMS надсилається поза з'єднанням: `grep -nE 'sms\.send\|withConnection' app/src/worker.js` → `24` (читання, з'єднання повернуто), `28` (`sms.send`), `33` (оновлення). `db_pool_in_use` вимірюється «у процесі API» (`incident/README.md`). |
| SMS-провайдер деградував саме 14.10 | Підтримку запитали, а 429 і TLS-таймаут ніби вказували на нього | Відправлення не впало, у вікні надіслано навіть більше: `awk -F'"count":' 'substr($0,19,5)>="14:02" && substr($0,19,5)<"14:47" && /sms batch sent/{s+=$2+0} END{print s}' incident/logs/worker-2026-10-14.jsonl` → `8655`; для `incident/baseline/worker-2026-10-13.jsonl` → `8265`. Провайдер також заперечив інциденти: `grep -n '14:36' incident/oncall-chat.md` (це лише слова провайдера, тому вирішальні числа вище). |
| TLS-таймаут о 14:01:37 — перша ланка, бо стався до розгортання | Перша помилка за часом, за 23 с до релізу; цим відкинули версію про реліз | Поодинока подія, яка буває і в звичайний день: `grep -h 'TLS handshake' incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → по одному рядку: `14:01:37` (14.10) і `13:12:45` (13.10). Це worker, а всі 503 — про пул API (докази 8a, 8b). |
| Витік пам'яті в API | `heap usage high`, 81 % у розпал інциденту | Та сама «пила», що й напередодні: `win incident/metrics/2026-10-14.csv heap_used_pct 12:00 14:02` → `avg 68.943 min 54 max 82`; `win incident/baseline/metrics-2026-10-13.csv heap_used_pct 12:00 14:02` → `avg 69.107 min 55 max 82`. Попереджень навіть менше: `grep -c 'heap usage high' incident/logs/api-2026-10-14.jsonl` → `63`; для `incident/baseline/api-2026-10-13.jsonl` → `70`. Краху немає: `grep -c -i -E 'out of memory\|oom\|fatal\|crash' incident/logs/api-2026-10-14.jsonl` → `0`. Перезапуск скинув heap до 42–43 %, а 503 тривали (доказ 13). |
| Сплеск трафіку перевантажив API | Інцидент припав на пік, p95 зріс | Трафік такий самий, як напередодні: доказ 11 → `11.802` проти `11.849` rps. Того дня 503 не було: доказ 8c → `0`. |
| Самі PostgreSQL або мережа до неї | Симптом — очікування на БД | **Прямих даних немає, логів PostgreSQL у теці нема.** Побічно спростовано: `in_use` не «плаває», а стоїть рівно на 4 (доказ 6a), тобто впирається в ліміт процесу; щойно ліміт зник, та сама БД обслужила 14 з'єднань без черги: `grep '^2026-10-14T14:47' incident/metrics/2026-10-14.csv` → `...,14,0,...`. |
| Інша зміна релізу: довший текст SMS | Це єдина зміна логіки в diff, а тариф залежить від довжини | Текст обробляє лише worker, не API. Обидва варіанти вміщаються в 70 символів кирилицею (`materials/vendors/sms-provider.md:8`): `node -e "console.log('Посилка чекає у поштоматі №123. Код: 123456'.length,'Ваша посилка у поштоматі №123. Код отримання: 123456'.length)"` → `43 52`. |
| Помилка `reading 'trim'` у `POST /parcels` | Справжня 500 у лозі, у тому самому вікні | Вона була й раніше, з тією самою частотою: `grep -c "reading 'trim'" incident/logs/api-2026-10-14.jsonl` → `125`; для `incident/baseline/api-2026-10-13.jsonl` → `128`. Окремий баг (`app/src/parcels.js:42`), але не цей інцидент. |
| Короткий перехідний ефект після розгортання (холодний старт) | Симптоми почалися одразу після старту | Перехідний ефект минув би, а тут 45 хв без спаду, і після перезапуску все повторилося: `win incident/metrics/2026-10-14.csv error_rate 14:04 14:47` → `min 0.0676 max 0.1347` (доказ 13). |
| Несправність конкретних поштоматів | Гаряча лінія назвала Соборну і Шкільну | Збій спільний для всього API: 503 є і на `/parcels`, і на `/admin/parcels`, які не залежать від екрана поштомата (доказ 9). |
| Масове надходження посилок спричинило сплеск SMS (припущення `rca-v1.md`) | Об 13:28 обсяг SMS зростає приблизно у 12 разів | Це щоденна картина, а не подія 14.10: `awk -F'"count":' '/sms batch sent/{t=substr($0,19,5); if(t>="13:24" && t<"15:02")b+=$2+0} END{print b}' incident/logs/worker-2026-10-14.jsonl` → `17228`; для `incident/baseline/worker-2026-10-13.jsonl` → `16533`. |
| Витік з'єднань у v1.8.0 (`rca-v1.md`: «менш імовірно, але не спростовано») | Пул вичерпано, а 503 наростали кілька хвилин після 14:02 | Реліз не змінює роботу зі з'єднаннями (доказ 20 → `0`). З'єднання повертається у `finally`: `grep -n 'finally' app/src/db.js` → `98:`. Витік зростав би поступово, а `in_use` дорівнює 4 вже в першу хвилину: `grep '^2026-10-14T14:02' incident/metrics/2026-10-14.csv` → `...,4,4,42,44`. |
| Worker на v1.8.0 — справжнє джерело (`rca-v1.md`: «не спростовано») | Worker і API відкотилися майже одночасно, тому логи їх не розділяють | У кожного процесу свій пул: `grep -n 'createPool(' app/src/server.js app/src/worker.js` → `server.js:91`, `worker.js:43`. Метрика стосується API: `grep -n 'db_pool_in_use' incident/README.md` → «у процесі API». Зміни worker-а — лише тексти (доказ 21). |
| Другий чинник у релізі: довше утримання або додаткові з'єднання на запит (`rca-v1.md`) | Арифметика: ліміт 4 сам по собі не пояснює перевантаження за 12 rps (доказ 23) | **Спростовано лише для коду релізу:** доказ 20 → `0`, доказ 21 → лише тексти, доказ 22 → `parcels.js` не змінено, тож три з'єднання на `/pickup` не нові. **Сама арифметика лишається відкритим питанням**, див. «Впевненість». |
| Завислий процес, який вилікував би перезапуск (`rca-v1.md`) | Типова перша дія; перезапуск справді робили о 14:20 | Перезапуск нічого не змінив: `in_use` лишився 4, а `error_rate` за хвилину повернувся до 0.1068 (доказ 13). |
| `<заповнює учасник>` Що підозрювали ви самі | `<...>` | `<...>` |

## Чинники, що сприяли (contributing factors)

**Дали помилці потрапити в продакшн**

- **Мовчазний запасний варіант.** `app/src/config.js:9` підставляє значення для локальної
  розробки, якщо змінної немає. Продакшн не може відрізнити «не задано» від «задано 4»,
  і сервіс стартує без попередження.
- **Тести не звіряють `compose.yaml` з кодом.** Із релізом усі 15 тестів зелені (доказ 16);
  `app/test/config.test.js` перевіряє лише `DB_POOL_MAX`.
- **Перейменування важко помітити в diff.** Сортування за алфавітом переставило весь блок
  змінних (`incident/changes/v1.8.0.diff:66-115`), а реліз описано як «config cleanup».

**Затримали виявлення й усунення**

- **`/health` не перевіряє БД** (`app/src/server.js:37`), тому весь інцидент відповідав 200.
- **Розмір пулу ніде не видно на старті:** `app/src/server.js:95` логує лише версію.
- **Немає алерту на насичення пулу:** `db_pool_waiting` збирається, але в
  `incident/alerts.json` є лише алерти на 429, p95 і 5xx.
- **Шумний алерт на 429 спрямував розслідування хибним шляхом.** Його умова виконувалась і
  в звичайний день. Ймовірне, але не доведене джерело 429: `deploy/compose.yaml:20` задає
  `SMS_RATE_PER_SEC: "20"`, ліміт облікового запису — 10 на секунду
  (`materials/vendors/sms-provider.md:16`), а `app/src/sms.js` не читає `Retry-After`.
  Це окрема проблема, яку варто виправити.
- **Часовий збіг хибно виправдав реліз.** TLS-таймаут за 23 с до релізу і опис релізу як
  несуттєвого відвели увагу від нього. Те, що помилки почалися через 7 с після старту, у чаті
  не звірили; до відкату минуло 45 хв. На момент рішень це було зрозуміло: алерт на 429
  справді спрацював раніше за реліз, а прямого сигналу про пул ніхто не отримував.
- **Немає перевірки після розгортання чи поетапного викочування.** Є лише один API на одній
  VM. У спокійні години обмеження могло б і не проявитися: до 12:50 `in_use` не перевищував 4
  (`win incident/metrics/2026-10-14.csv db_pool_in_use 12:00 12:50` → `max 4`).

**Збільшили можливу шкоду**

- **`pickup()` не є транзакцією:** три окремі з'єднання, тому часткове виконання можливе
  (докази 10, 17, 18). Такі посилки могли застрягти: нічна задача бере лише `waiting`
  (`app/src/parcels.js:81`). **Потрібна перевірка в продакшні:** знайти посилки `picked_up`
  за 14:02–14:47 без відповідної події.

## Впевненість

**Висока, близько 95 %** — щодо першопричини.

- **Що підтверджує.** Незалежні джерела сходяться в одному механізмі: diff і код, відтворення
  конфігурації (доказ 4), рівно 4 з'єднання всі 45 хв, 3380 із 3380 помилок 503 з однією
  причиною, збіг найдовших 503 з кількістю з'єднань на запит. Початок і кінець збою збігаються
  з розгортанням і відкатом, а трафік, 429 і heap при цьому не змінилися. Базовий день
  показує, що всі відкинуті сигнали є звичайним фоном.
- **Чого бракує.** Немає прямого запису фактичного значення: дампа оточення контейнера або
  рядка в лозі з розміром пулу. Немає логів PostgreSQL. `app/` і `deploy/` зафіксовано у стані
  v1.7.3, тому v1.8.0 відтворено накладанням diff.
- **Що не сходиться кількісно.** `rca-v1.md` слушно зауважив: якщо запит триває 73,5 мс, 4
  з'єднань вистачило б приблизно на 54 rps, а не лише на 12 (доказ 23). Перша відповідь цього
  прогону (Частина 1) цю нестиковку не розглядала. Частково її пояснює те, що середня тривалість
  не описує піків: `db_pool_in_use` — максимум за хвилину, і на v1.7.3 він сягав 10–13 за тієї
  самої швидкості запитів (докази 6b, 6c, 24). Але безперервна черга передбачає утримання
  близько 0,38 с, а час утримання з'єднання ніхто не вимірював, тому **модель навантаження не
  доведено**. Так само не пояснено, чому після 14:02 черга наростала близько 3 хв, а після 14:20
  — близько 1 хв. На висновок про причину це не впливає: реліз не змінив код зі з'єднаннями
  (докази 20–22), тож серед змін у diff пояснює рівно 4 з'єднання лише перейменування.
- **Припущення.** У продакшн потрапив саме `compose.yaml` із diff. PostgreSQL-реалізація
  поводиться так само, як `app/src/db.js` у пам'яті (пул і відсутність транзакції).
- **Що змінило б висновок.** Дамп оточення v1.8.0 із `DB_POOL_MAX=20`, або логи PostgreSQL із
  власним лімітом чи збоєм о 14:02–14:47. Ще один непокритий diff канал —
  `FROM node:latest` у `deploy/Dockerfile:1`: перезбірка могла змінити версію Node, і дані цього
  не показують. Навантажувальний тест v1.7.3 із `DB_POOL_MAX=4` проти PostgreSQL перевірив би,
  чи ліміт сам по собі відтворює 11 % помилок за 12 rps.

**Середня** — щодо побічної шкоди в `pickup()` (докази 17, 18). Механізм відтворюється на коді
з репо, але стан бази продакшну недоступний, а 1 % вибірки логу не дозволяє побачити зростання
кодів 404. Оцінку `205` слід вважати нижньою межею лише за умови зазначених припущень.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | Реліз 1.8.0 лишив API з ефективним лімітом 4 з'єднання, і пул вичерпався; конкретний дефект не встановлено | Реліз v1.8.0 перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` лише в `compose.yaml`; код узяв типове значення, і пул зменшився з 20 до 4 |
| Впевненість, яку заявив AI | Реліз — висока, близько 95 %; механізм — висока, близько 85 %; знижений параметр пулу — близько 50–60 % | Висока, близько 95 % |
| Збігається з вашою? | Із цим RCA — частково: тригер і механізм так, конкретний дефект не названо. `<підтверджує учасник>` | Із цим RCA — так, але це той самий прогін, а не незалежна перевірка. `<підтверджує учасник після заповнення docs/rca.md>` |
| Що в даних вплинуло на відповідь | — | `changes/v1.8.0.diff` разом з `app/src/config.js` дали конкретний дефект, якого v1 не міг побачити; `baseline/` підтвердив, що 429, TLS і heap є звичайним фоном. Механізм і майже всі відкинуті версії v1 знайшов уже без цих даних |
