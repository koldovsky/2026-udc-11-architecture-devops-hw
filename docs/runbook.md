# Runbook: API повільний або відповідає 5xx (`ApiLatencyP95High`, `Api5xxRateHigh`)

> Для чергового, який інциденту 14.10 не бачив. Кожен крок — команда для копіювання і
> підказка, що у виводі означає «так» чи «ні». Розбір того інциденту — [`docs/rca.md`](rca.md).
>
> **Де виконувати.** Команди з `ssh` запускаються на VM `poshtomat-prod-1` у теці `/opt/poshtomat`.
> Туди деплой (`pipeline/deploy.yml`) кладе `compose.yaml` і `.env` (образ за digest і секрети),
> а після кожного **успішного** деплою (крім першого) лишає попередні — `compose.yaml.prev`
> і `.env.prev`. Після першого деплою їх немає. Після невдалого, що дійшов до заміни файлів, їх теж немає: автоматичний
> відкат переносить їх назад (`pipeline/deploy.yml`, `mv … .prev`; і якщо він не вдався, `.prev`
> теж уже немає, а `compose.yaml` і `.env` — попередній реліз; чи він запущений, покаже `ps -a` — див.
> «Що робити», рядок 1), а файли невдалого релізу
> лишає як `compose.yaml.failed` і `.env.failed`. Після невдалого **першого** деплою немає й
> `compose.yaml` та `.env`: скрипт зупиняє api і worker і лишає тільки `.failed`. Стан і логи тоді —
> `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat -f compose.yaml.failed --env-file .env.failed ps -a"` і
> `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat -f compose.yaml.failed --env-file .env.failed logs worker"`
> (команди з `--env-file .env` нижче в цьому разі не спрацюють).
> Якщо деплой упав ще на перевірці файлів чи завантаженні образу (`config --quiet`, `pull --quiet`),
> на VM нічого не змінилось: працює попередній реліз (якщо деплой перший — нічого), файлів
> `.failed` немає. Причину шукайте в лозі кроку «Розгортання» в GitHub Actions. `.prev` тоді
> лишаються від попереднього успішного деплою й описують реліз **до** поточного — для такого
> запуску відкат з `.prev` не робіть. Проєкт compose
> — `poshtomat`, тому всі команди мають вигляд `docker compose -p poshtomat --env-file .env …`.
> Шлях до теки й ім'я VM звірте один раз заздалегідь, а не під час інциденту.
> Команди з позначкою «з репо» працюють на ноутбуці з кореня репозиторію в Git Bash.

- **Алерти:**
  - `ApiLatencyP95High` — `p95_ms > 2000` протягом 3 хв, page;
  - `Api5xxRateHigh` — `error_rate > 0.05` протягом 3 хв, page.
  - Найчастіше спрацьовують разом.
- **Що це означає для користувачів:**
  - мешканець вводить код, а поштомат показує «Сервіс зайнятий, спробуйте пізніше» (це 503 з API) і не відчиняє комірку;
  - кур'єр не може зареєструвати посилку;
  - персонал не бачить список у адмінці.
- **Скільки є часу:** нуль. Люди стоять біля поштомата. 14.10 у пік було ~57 невдалих
  видач за хвилину (2586 за 45 хв). Мета — відновити сервіс за **15 хв** від пейджа,
  навіть якщо причина ще невідома.

## Перші 5 хвилин

1. **Підтвердіть пейдж у #poshtomat-oncall:** «Взяв(ла) ApiLatencyP95High / Api5xxRateHigh,
   дивлюсь». Тоді ніхто не дублює роботу, а гаряча лінія знає, що проблему бачать.
2. **Не довіряйте `/health`.** Він не ходить у БД і відповідає 200, навіть коли сервіс
   лежить (`app/src/server.js:37`). Перевіряйте пробним запитом, що проходить через пул БД
   і нічого не змінює:
   ```bash
   ssh poshtomat-prod-1 "curl -s -w ' %{http_code} %{time_total}s\n' -H 'Authorization: Bearer probe' http://localhost:8080/admin/parcels"
   ```
   - `{"error":"forbidden"} 403 0.02s` — **API і пул у порядку.** Токен `probe` не існує,
     але щоб це з'ясувати, API сходив у БД (`app/src/server.js:18`).
   - `{"error":"service busy, try again"} 503 ~2s` — **пул БД вичерпано.** Запит
     2 с чекав з'єднання (`app/src/server.js:65`). Ідіть на крок 3.
   - `{"error":"internal error"} 500` — помилка в коді або БД. Див. «Діагностику», рядок 3.
   - Немає відповіді — API лежить. Подивіться стан контейнерів на VM:
     `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env ps -a"`.
3. **Чи був деплой або рестарт за останню годину?** Це найімовірніша причина, перевіряйте її першою:
   ```bash
   ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env logs --since 2h api worker | grep -E '\"(service started|worker started)\"'"
   ```
   - Є рядок `service started` з новою `version` менш як годину тому → **одразу відкат**
     (див. «Що робити», рядок 1). Причину шукайте потім. 14.10 деплой за 4 хв до пейджа
     відкотили лише через 45 хв, бо спершу шукали причину.
   - Деплоїв немає → «Діагностика».
4. **Не робіть рестарт як перший крок.** Рестарт тієї самої версії з тією самою
   конфігурацією не допомагає: 14.10 після рестарту черга повернулась за хвилину.

## Діагностика

| Питання | Команда | Як читати результат |
|---|---|---|
| 1. Яка версія працює і коли стартувала? | `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env logs --since 24h api \| grep '\"service started\"' \| tail -3"` | Остання `version` відрізняється від учорашньої і старт був недавно → підозра на реліз, «Що робити», рядок 1 |
| 2. Чи впирається пул БД у стелю? | Дашборд: `db_pool_in_use` і `db_pool_waiting` за останню годину | `waiting > 0` і `in_use` — **рівна лінія** на одному числі → пул замалий (стеля = його розмір). Наступне питання — яка стеля. `waiting = 0` → пул ні до чого, дивіться рядок 3 |
| 3. Які саме помилки віддає API? | `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env logs --since 15m api \| grep '\"request failed\"' \| grep -o '\"error\":\"[^\"]*\"' \| sort \| uniq -c \| sort -rn"` | `db pool wait timeout after 2000ms` — пул (рядки 2, 4). `Cannot read properties of undefined (reading 'trim')` — **фоновий баг**, ~125 на день, не причина пейджа. Інше (наприклад, `ECONNREFUSED`, `too many clients`) — БД, рядок 6 |
| 4. Який розмір пулу насправді отримав API? | `ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env exec -T api node -e 'import(\"./src/config.js\").then(m=>{const c=m.loadConfig();console.log(\"dbPoolMax\",c.dbPoolMax,\"waitMs\",c.dbPoolWaitMs)})'"` | Має бути `dbPoolMax 20`. Якщо `4` — **API не бачить `DB_POOL_MAX`** і взяв значення для локальної розробки (`app/src/config.js:9`). Секрети ця команда не друкує |
| 5. Чи всі змінні з compose читає застосунок? (на VM: розгорнутий `compose.yaml` проти `config.js` із запущеного образу api) | `ssh poshtomat-prod-1 'cd /opt/poshtomat && docker compose -p poshtomat --env-file .env exec -T api cat src/config.js > /tmp/poshtomat-config.js && for k in $(grep -oE "^\s+[A-Z_]+:" compose.yaml \| tr -d " :" \| sort -u); do grep -q "env\.$k\b" /tmp/poshtomat-config.js && echo "ok $k" \|\| echo "НЕ ЧИТАЄТЬСЯ $k"; done'` | Звіряються саме ті файли, що працюють у проді, а не локальний checkout: у ньому назву могли вже виправити, і перевірка сказала б `ok`. Усі `ok`, крім `TZ` (її читає Node, це нормально). Будь-яке інше `НЕ ЧИТАЄТЬСЯ` — неправильна назва змінної. Застосунок мовчки бере значення за замовчуванням. 14.10 тут було б `НЕ ЧИТАЄТЬСЯ DB_POOL_SIZE` |
| 6. Чи жива PostgreSQL і скільки в неї з'єднань? | `ssh poshtomat-prod-1 "sudo -u postgres psql -d poshtomat -Atc \"select state, count(*) from pg_stat_activity where datname='poshtomat' group by 1\""` | Відповідь за секунду, з'єднань не більше ~60 (3 процеси × `DB_POOL_MAX` 20) → БД у порядку, причина в API. Тайм-аут або помилка → БД, ескалюйте |
| 7. Чи не вікно бекапу? | `date +%H:%M` (Київ) | **02:00–02:30** база заблокована на запис (`docs/ops/backup-runbook.md:10-11`): реєстрація і видача падають за розкладом. Це не цей runbook, див. backup-runbook |
| 8. Чи зріс трафік? | Дашборд: `rps` зараз і в той самий час учора | Приблизно як учора (у пік ~12 rps) → навантаження ні до чого. Різко більше → ескалюйте, рядок 4 у «Що робити» |

## Як підтвердити причину

Ці сигнали відрізняють поширені причини одну від одної. Покладатися можна тільки на них:

- **Закоротка конфігурація після релізу**, як 14.10:
  - стався деплой;
  - `db_pool_in_use` стоїть рівною лінією на числі, меншому за 20, частіше на 4;
  - `db_pool_waiting > 0`;
  - діагностика, рядок 4, показує `dbPoolMax` не 20.
  - Усі чотири разом — причину доведено.
- **БД.** `db_pool_waiting` росте, але `in_use` дорівнює 20, а рядок 6 повільний або з помилками.
- **Навантаження.** rps помітно вищий, ніж учора, а `in_use` дорівнює 20.

**Що НЕ є причиною пейджа API**, хоч і виглядає підозріло (перевірено 13.10 і 14.10):

- **алерт `SmsProvider429RateHigh` і рядки `sms provider rate limited`.** Це щоденний пік
  о 13:30–15:00. Відповіді 429 отримує тільки worker, а не API, і API вони не гальмують;
- **поодинокий `TLS handshake timeout to sms.example.net` у worker.** Буває раз на день;
- **`heap usage high`, 75–82 %.** Це нормальна «пилка» збирача сміття, 60–70 попереджень на день.

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| 1. Новий реліз (нова `version` у `service started`) запустився на VM менш як 60 хв тому (будь-яка причина): крок 3 «Перших 5 хвилин» або діагностика, рядок 1. Деплой, що впав на `config`/`pull`, нічого не перезапускає — сюди не потрапить | **Відкат на попередній реліз — і образу, і `compose.yaml` разом.** Основний спосіб — на VM із `.prev`-файлів останнього успішного деплою (команда праворуч), потім «Перевірка worker» під таблицею. Він працює, лише якщо є обидва файли. Їх немає після першого деплою і після невдалого — тоді дивіться лог кроку «Розгортання». «відкат вдався» — працює реліз, що був до невдалого деплою; якщо пейдж через нього (він теж вийшов менш як 60 хв тому), відкат — лише `git revert` у `main`. «ВІДКАТ НЕ ВДАВСЯ» — у `compose.yaml` і `.env` попередній реліз, але й він не пройшов перевірок деплою; чи він працює, покажуть `ps -a` і крок 2 «Перших 5 хвилин»; якщо API не відповідає — одразу ескалюйте («Коли ескалювати»). Другий спосіб, якщо `.prev` немає: `git revert` поганого коміту в `main` і звичайний деплой з погодженням (~10 хв; команди — «Відкат через `git revert`» під таблицею). **Re-run** старого запуску в GitHub Actions відкатом не є — його зупинить перевірка «Коміт досі голова main» | `ssh poshtomat-prod-1 'cd /opt/poshtomat && { test -f compose.yaml.prev && test -f .env.prev \|\| { echo "немає .prev: перший деплой або вже автовідкат — див. лог «Розгортання»: «відкат вдався» → працює реліз до невдалого, якщо пейдж через нього — git revert у main; «ВІДКАТ НЕ ВДАВСЯ» → крок 2, потім ескалюйте; інакше git revert у main"; exit 1; }; } && cp compose.yaml compose.yaml.bad && cp .env .env.bad && cp compose.yaml.prev compose.yaml && cp .env.prev .env && grep "^POSHTOMAT_IMAGE=" .env && docker compose -p poshtomat --env-file .env up -d --remove-orphans && docker compose -p poshtomat --env-file .env up -d --wait --wait-timeout 120 api'` | **Відкочуйте compose разом з образом.** Якщо відкотити лише образ, неправильна змінна лишиться. `--build` не допоможе: образ на VM не збирається, його задає `POSHTOMAT_IMAGE` у `.env`. Попередній образ лишається на VM, бо старі образи ніхто не видаляє. Після відкату перевірте крок 2 з «Перших 5 хвилин» і `service started` зі старою версією. Відкат займає ~2 хв і без міграцій БД безпечний |
| 2. Рядок 4 дає `dbPoolMax 4`, а відкат неможливий | Повернути правильну назву змінної в `/opt/poshtomat/compose.yaml`. Змінні спільні для api, worker і expire (блок `x-env`), тож одна правка виправляє всі. Потім перестворити контейнери і виконати «Перевірку worker» під таблицею | `ssh poshtomat-prod-1 'cd /opt/poshtomat && cp compose.yaml compose.yaml.bak && sed -i "s/^\( *\)DB_POOL_SIZE:/\1DB_POOL_MAX:/" compose.yaml && grep -n DB_POOL compose.yaml && docker compose -p poshtomat --env-file .env up -d --remove-orphans && docker compose -p poshtomat --env-file .env up -d --wait --wait-timeout 120 api'` — замість `DB_POOL_SIZE` підставте неправильну назву з діагностики, рядок 5 | Уся команда виконується на VM, в одних лапках `ssh`. `grep` має показати `DB_POOL_MAX: "20"`. Це правка на проді повз `main`: одразу після інциденту зробіть PR з тією самою зміною, інакше наступний деплой поверне помилку |
| 3. Пул упирається в 20, БД здорова, rps як учора | Ескалюйте розробнику: швидше за все, новий повільний запит або з'єднання тримається довше, ніж треба | — | Не збільшуйте пул наосліп: 3 процеси × N з'єднань мають уміститися в `max_connections` PostgreSQL |
| 4. Трафік різко вищий за звичайний | Повідомте координаторку, щоб з'ясувати джерело. Тимчасово `DB_POOL_MAX: "30"` лише для api | `ssh -t poshtomat-prod-1 'cd /opt/poshtomat && cp compose.yaml compose.yaml.bak && nano compose.yaml && docker compose -p poshtomat --env-file .env up -d --wait --wait-timeout 120 api'` — у `nano` додайте `DB_POOL_MAX: "30"` в `environment:` сервісу `api` після `PORT` | Перевірте `show max_connections` у psql до зміни |
| 5. БД не відповідає (рядок 6) | Ескалюйте розробнику, відповідальному за VM | `ssh poshtomat-prod-1 "sudo systemctl status postgresql"` | Сервіс без БД не відновиться рестартом API |
| 6. Помилки тільки `reading 'trim'` | Нічого: це фоновий баг на `/parcels`, пейдж його не спричинив. Шукайте далі | — | — |

**Перевірка worker** — після рядків 1, 2 і 4. Команди вище чекають лише на api, бо в worker
немає healthcheck. Worker, що падає в циклі, вони пропустять, а пробний запит до API однаково
дасть `403`. Вікно — 60 с, як у скрипті деплою: коротше пропустить worker, що падає раз на пів хвилини:

```bash
ssh poshtomat-prod-1 'cd /opt/poshtomat && id=$(docker compose -p poshtomat --env-file .env ps -a -q worker) && b=$(docker inspect -f "{{.RestartCount}}" "$id") && sleep 60 && docker inspect -f "{{.State.Status}} {{.RestartCount}} (було $b)" "$id"'
```

- `running 0 (було 0)` — **так**: за 60 с worker не перезапускався, тобто перший і другий лічильник однакові.
- Лічильник зріс (наприклад, `running 5 (було 0)`) або статус `restarting`/`exited` — **ні**,
  worker падає: `docker compose -p poshtomat --env-file .env logs --tail 50 worker` і ескалюйте.

Живий worker ще не означає, що він працює: помилку раунду (наприклад, тайм-аут пулу БД) він
лише пише в лог і продовжує цикл. Тому одразу після команди вище:

```bash
ssh poshtomat-prod-1 'cd /opt/poshtomat && logs=$(docker compose -p poshtomat --env-file .env logs --since 2m worker) && { printf "%s\n" "$logs" | grep -c "\"msg\":\"notify round failed\"" || [ $? -eq 1 ]; }'
```

- `0` — **так**: за 2 хв (~12 раундів) жоден раунд не впав.
- Більше `0` — **ні**: worker живий, але посилки не обробляє. Подивіться поле `error` у цих
  рядках і ескалюйте. `sms send failed` сюди не входить: поодинокі 429 і TLS-тайм-аути
  бувають щодня:

  ```bash
  ssh poshtomat-prod-1 'cd /opt/poshtomat && docker compose -p poshtomat --env-file .env logs --since 2m worker | grep "notify round failed" | tail -3'
  ```

- Числа немає, а є помилка `docker compose` — лог не прочитано, тож перевірка не відбулась.
  Це не «так»: повторіть команду, а якщо помилка лишається, ескалюйте.

Обидві перевірки за вікно 60 с робить і скрипт деплою (`up_and_wait` у `pipeline/deploy.yml`).

**Відкат через `git revert`** — з репо, коли `.prev` немає або треба відкотити реліз, який уже
працює (рядок 1). SHA поганого коміту — у запуску `deploy`, що його розгорнув (GitHub Actions →
запуск → коміт):

```bash
git switch main && git pull --ff-only && git log --oneline -5   # переконайтеся, що <sha> — той коміт
git revert --no-edit <sha> && git push origin main
```

- Для merge-коміту — `git revert -m 1 --no-edit <sha>`. Якщо `main` захищено від прямого
  пушу — те саме через PR.
- Пуш у `main` запускає `deploy`. Переконайтеся, що в GitHub Actions з'явився запуск саме з вашим
  revert-комітом, і погодьте job `deploy` (environment `production`). Запуску немає за 2–3 хв —
  ескалюйте.
- **Вдалося:** у лозі кроку «Розгортання» — `Розгорнуто: …`. Далі «Перевірка worker» вище,
  «Як переконатися, що все гаразд» і `service started` з версією до поганого релізу.
- У лозі `відкат вдався` або `ВІДКАТ НЕ ВДАВСЯ` — revert-реліз теж не пройшов перевірок: ескалюйте.

## Коли ескалювати і кого кликати

- **15 хв від пейджа, причини немає і відкат не допоміг або неможливий.** Дзвоніть
  розробнику, який цього тижня **не** чергує. Розробників двоє, вони чергують по тижню
  (`materials/team.md`).
- **Деплой не ваш і ви не впевнені, що відкат безпечний,** наприклад реліз змінював схему БД.
  Дзвоніть автору релізу, але **не чекайте на нього більше 5 хв, щоб відкотити**.
- **Вплив понад 15 хв.** Напишіть координаторці проєкту в #poshtomat-oncall або на
  poshtomat-team@example.org, щоб гаряча лінія і мешканці знали про збій і термін.
- **PostgreSQL не відповідає або йде вікно бекапу.** Звертайтеся до розробника, відповідального за VM, і дійте за `docs/ops/backup-runbook.md`.

## Як переконатися, що все гаразд

- Пробний запит з кроку 2 повертає `403` за менше ніж 0,3 с. Повторіть його 3–5 разів.
- На дашборді **10 хв поспіль**:
  - `db_pool_waiting = 0`;
  - `p95_ms` < 300;
  - `error_rate` < 0,01. Фонові 0,1–0,5 % — це баг `trim`.
- Стеля `db_pool_in_use` зникла: у пік лінія коливається (14.10 після відкату — 11–14), а не стоїть рівно.
- Обидва пейджі закрились самі, без ручного «resolve».
- Діагностика, рядок 4: `dbPoolMax 20`.
- Лог API за 5 хв без `db pool wait timeout`:
  ```bash
  ssh poshtomat-prod-1 "cd /opt/poshtomat && docker compose -p poshtomat --env-file .env logs --since 5m api | grep -c 'db pool wait timeout'"
  ```
  Очікується `0`.
- Напишіть у #poshtomat-oncall: що бачили, що зробили, о котрій відновилося.
  Відкат без відомої причини — це **не кінець**: причину треба знайти до наступного деплою
  того самого релізу (див. `docs/postmortem.md`).
