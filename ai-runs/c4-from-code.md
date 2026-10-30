- Інструмент і модель: Claude Code 2.1.310, headless `claude -p`; модель claude-opus-5-5, effort medium
- Дата: 2026-10-24
- Що бачила сесія: тимчасова тека `../ws11-b-code/` поруч із репо, у ній лише копія всієї `app/` (перевірено `diff -r` — ідентична). Нова сесія (`--session-id c394e269-cc1c-4498-ad96-3b102bbc257a`) з прапорцями `--safe-mode --restricted --strict-mcp-config --tools "Read,Grep,Glob"`: без `CLAUDE.md`/`AGENTS.md`, пам'яті, хуків, плагінів користувача, output styles і MCP (`mcp_servers` порожній; `~/.claude/CLAUDE.md` порожній, 0 байт); файлові інструменти обмежені тимчасовою текою прапорцем `--restricted`. Усі виклики були всередині теки, відмов не було (`permission_denials` порожній). Виклики: Glob `**/*`; Read `app/docs/ARCHITECTURE.md`, `app/README.md`, `app/package.json`, 8 з 9 файлів `app/src/` — усі, крім `version.js`, — і `app/bin/expire-parcels.js`; тести не читала. Bash вимкнено.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче дві C4-діаграми, які я склав за кодом у `app/`. Документацію `docs/ARCHITECTURE.md` я використовував лише як допоміжне джерело: вона місцями відстає від коду (розбіжності перелічено в кінці).

## Рівень 1 — System Context

```mermaid
C4Context
  title Поштомат громади: System Context

  Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
  Person(staff, "Персонал громади", "Переглядає список посилок (staff / admin)")

  System_Ext(terminal, "Екран поштомата", "Термінал у поштоматі: приймає введений код")
  System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку, коли її кладуть у комірку")

  System(poshtomat, "Поштомат громади", "Реєструє посилки, шле коди отримання, видає посилки, повертає незабрані")

  System_Ext(sms, "SMS-провайдер", "HTTP API: POST /messages")
  System_Ext(courier, "Служба доставки: API повернень", "HTTP API: POST /returns")
  System_Ext(monitoring, "Моніторинг", "Опитує стан сервісу")

  Rel(resident, terminal, "Вводить 6-значний код")
  Rel(terminal, poshtomat, "Надсилає код", "HTTPS/JSON, POST /pickup")
  Rel(scanner, poshtomat, "Реєструє посилку", "HTTPS/JSON, POST /parcels")
  Rel(staff, poshtomat, "Переглядає посилки", "HTTPS/JSON, Bearer-сесія")
  Rel(monitoring, poshtomat, "Перевіряє стан", "GET /health")

  Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTPS/JSON, Bearer token")
  Rel(sms, resident, "Доставляє SMS")
  Rel(poshtomat, courier, "Просить забрати посилку назад (понад 72 год)", "HTTPS/JSON")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2 — Container

```mermaid
C4Container
  title Поштомат громади: Containers

  Person(resident, "Мешканець")
  Person(staff, "Персонал громади")
  System_Ext(terminal, "Екран поштомата")
  System_Ext(scanner, "Сканер служби доставки")
  System_Ext(monitoring, "Моніторинг")
  System_Ext(sms, "SMS-провайдер", "POST /messages")
  System_Ext(courier, "API повернень служби доставки", "POST /returns")

  System_Boundary(vm, "Одна VM") {
    Container(api, "API", "Node.js 22, node:http; docker compose сервіс `api`", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Генерує 6-значні коди, маскує телефони для персоналу")
    Container(worker, "SMS Worker", "Node.js 22; docker compose сервіс `worker`, той самий образ", "Цикл: кожні 10 с бере до 50 посилок без сповіщення; ліміт 5 SMS/с, ретраї на 429")
    Container(expire, "Нічна задача повернень", "Node.js 22 скрипт bin/expire-parcels.js; cron на хості VM", "Позначає посилки, що лежать понад 72 год, як returned і замовляє повернення")
    ContainerDb(db, "PostgreSQL", "На VM, поза контейнерами", "Посилки, події, сесії персоналу")
  }

  Rel(scanner, api, "Реєструє посилку", "POST /parcels")
  Rel(resident, terminal, "Вводить код")
  Rel(terminal, api, "Надсилає код", "POST /pickup")
  Rel(staff, api, "Список посилок", "GET /admin/parcels, Bearer")
  Rel(monitoring, api, "Перевіряє стан", "GET /health")

  Rel(api, db, "Читає/пише посилки, події; шукає сесії", "SQL, пул ≤ DB_POOL_MAX")
  Rel(worker, db, "listUnnotified / позначає notifiedAt", "SQL")
  Rel(expire, db, "Шукає прострочені / позначає returned", "SQL")

  Rel(worker, sms, "Текст з номером поштомата і кодом", "HTTPS/JSON, Bearer SMS_TOKEN")
  Rel(sms, resident, "SMS")
  Rel(expire, courier, "Запит на повернення (reason: not_picked_up_72h)", "HTTPS/JSON")

  UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")
```

## Припущення

1. **Екран поштомата і сканер я показав як зовнішні системи.** Їхнього коду в репозиторії немає, тому вважаю їх окремим ПЗ, яке просто звертається до API.
2. **Сканер і API повернень належать одній службі доставки,** але на діаграмі це два окремі елементи, бо вони працюють різними каналами.
3. **PostgreSQL.** У репозиторії замість бази є сховище в пам'яті (`src/db.js`). Дані про PostgreSQL на тій самій VM і склад таблиць взято з документації та коментарів. Рядок `DATABASE_URL` є в `src/config.js:7`, але в коді не використовується.
4. **Розгортання.** Каталогу `deploy/` у робочій теці немає. Дані про `docker compose` з двома сервісами з одного образу взято з документації. Те, що нічна задача запускається через cron на хості, а не в контейнері, видно з коментаря в `bin/expire-parcels.js:2`.
5. **Сесії персоналу.** Ендпоінту для входу немає. Вважаю, що сесії створюються поза цією системою; API лише шукає їх у БД (`src/server.js:14`).
6. **HTTPS на зовнішніх зв'язках.** Сервер слухає звичайний HTTP на `PORT` (типово 8080). Тому вважаю, що TLS додає щось перед ним, наприклад reverse proxy, якого на діаграмі немає.

## Де документація розходиться з кодом

Діаграми побудовані за кодом:

| | `docs/ARCHITECTURE.md` (v1.5) | Код (v1.7.3) |
|---|---|---|
| Інтервал worker | 30 с | 10 с, а при повному батчі (50 посилок) одразу наступний раунд (`src/worker.js:8`) |
| Код отримання | 4 цифри | 6 цифр (`src/parcels.js:27`) |
| Повернення | лише «позначає як повернені» | ще й викликає API повернень служби доставки (`src/courier.js`) |
| Ліміт SMS | не згадано | 5 на секунду, до 4 спроб з backoff на 429 (`src/sms.js`) |

Окремо: у нічній задачі посилку спершу позначають як `returned`, а вже потім викликають служби доставки (`bin/expire-parcels.js:14-15`). Якщо цей виклик впаде, посилка лишиться позначеною як повернена, але запиту на повернення не буде. Крім того, задача зупиниться і решту посилок не обробить. На діаграмах цього не видно, але з цим зв'язком варто бути обережним.
