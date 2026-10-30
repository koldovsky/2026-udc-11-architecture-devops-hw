- Інструмент і модель: Claude Code 2.1.310, headless `claude -p`; модель claude-opus-5-5, effort medium
- Дата: 2026-10-24
- Що бачила сесія: тимчасова тека `../ws11-b-docs/` поруч із репо, у ній лише `app/README.md` і `app/docs/ARCHITECTURE.md`. Нова сесія (`--session-id 62b70b08-0284-46f4-9ed3-e41d86d624d0`) з прапорцями `--safe-mode --restricted --strict-mcp-config --tools "Read,Grep,Glob"`: без `CLAUDE.md`/`AGENTS.md`, пам'яті, хуків, плагінів користувача, output styles і MCP (`mcp_servers` порожній; `~/.claude/CLAUDE.md` порожній, 0 байт); файлові інструменти обмежені тимчасовою текою прапорцем `--restricted`. Усі виклики були всередині теки, відмов не було (`permission_denials` порожній). Виклики: Glob `**/*`; Read `app/docs/ARCHITECTURE.md`, `app/README.md`. Bash вимкнено.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Ось C4-діаграми рівнів System Context і Container для «Поштомата громади».

**Звідки взято дані.** У робочій директорії є тільки два файли: `app/README.md` і `app/docs/ARCHITECTURE.md`. Коду (`src/`, `bin/`, `deploy/`), на який вони посилаються, тут немає. Тому діаграми побудовані лише за документацією (v1.5, червень 2026), і з кодом я їх не звіряв.

## Рівень 1: System Context

```mermaid
C4Context
    title System Context — «Поштомат громади»

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку на поштоматі")
    Person(courier, "Служба доставки", "Реєструє посилку, скануючи її сканером")
    Person(staff, "Персонал", "Переглядає список посилок")

    System(postomat, "Поштомат громади", "Реєструє посилки, сповіщає мешканців, видає посилки за кодом")

    System_Ext(sms, "SMS-провайдер", "Зовнішній HTTP API для надсилання SMS")
    System_Ext(monitoring, "Система моніторингу", "Регулярно опитує стан сервісу")

    Rel(courier, postomat, "Реєструє посилку", "сканер → HTTP")
    Rel(resident, postomat, "Вводить код отримання", "екран поштомата")
    Rel(staff, postomat, "Переглядає посилки", "HTTP")
    Rel(postomat, sms, "Надсилає SMS з кодом", "HTTPS API")
    Rel(sms, resident, "Доставляє SMS з 4-значним кодом", "SMS")
    Rel(monitoring, postomat, "Перевіряє стан", "GET /health")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2: Container

```mermaid
C4Container
    title Container — «Поштомат громади»

    Person(resident, "Мешканець", "Забирає посилку за кодом")
    Person(courier, "Служба доставки", "Реєструє посилки")
    Person(staff, "Персонал", "Переглядає посилки")

    System_Ext(sms, "SMS-провайдер", "HTTP API")
    System_Ext(monitoring, "Система моніторингу", "Health-check")

    Container_Ext(scanner, "Сканер служби доставки", "Пристрій / клієнт", "Надсилає дані про посилку")
    Container_Ext(kiosk, "Екран поштомата", "Термінал поштомата", "Приймає код від мешканця")

    Deployment_Node(vm, "Одна VM", "Linux") {
        System_Boundary(sys, "Поштомат громади") {
            Container(api, "API", "Node.js 22, HTTP (docker compose: api)", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health")
            Container(worker, "Worker", "Node.js 22 (docker compose: worker, той самий образ)", "Кожні 30 с шукає посилки без сповіщення і шле SMS з кодом")
            Container(expire, "Нічна задача", "Node.js скрипт bin/expire-parcels.js", "Позначає посилки старші за 72 год як повернені")
            ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза контейнерами", "Таблиці: посилки, події, сесії персоналу")
        }
    }

    Rel(courier, scanner, "Сканує посилку")
    Rel(scanner, api, "Реєструє посилку", "POST /parcels")
    Rel(resident, kiosk, "Вводить код")
    Rel(kiosk, api, "Перевіряє код, видає посилку", "POST /pickup")
    Rel(staff, api, "Переглядає список", "GET /admin/parcels (сесія)")
    Rel(monitoring, api, "Опитує", "GET /health")

    Rel(api, db, "Читає/пише посилки, події, сесії", "SQL")
    Rel(worker, db, "Вибирає посилки без сповіщення, позначає сповіщені", "SQL")
    Rel(expire, db, "Позначає прострочені посилки як повернені", "SQL")
    Rel(worker, sms, "Надсилає SMS", "HTTPS API")
    Rel(sms, resident, "SMS з 4-значним кодом")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Припущення

1. **Сканер і екран поштомата я показав як зовнішні клієнти.** Вони не входять у систему, а лише звертаються до API. Якщо прошивку екрана розробляє та сама команда, екран варто зробити окремим `Container` усередині межі системи.
2. **Персонал** заходить у `GET /admin/parcels` якимось HTTP-клієнтом, напевно браузером. Окремого фронтенду в документації немає. Автентифікацію через сесії я вивів із таблиці «сесії персоналу».
3. **Нічну задачу** найімовірніше запускає cron на VM. Як саме її запускають, у документах не сказано. У `docker compose` згадано лише два сервіси (`api`, `worker`), тому задачу я показав окремим контейнером без прив'язки до compose.
4. **Систему моніторингу** в документах не названо. Відомо тільки, що вона опитує `/health`.
5. **Протоколи.** Канал до SMS-провайдера я позначив як HTTPS, а SMS доставляє мешканцю сам провайдер. У документах написано лише «HTTP API».
6. **Звідки береться номер телефону мешканця**, з документів не видно. Імовірно, його передають у `POST /parcels`, але окремого реєстру мешканців чи зовнішньої системи на схемі немає.
7. **Сховище.** README каже, що в репозиторії воно працює в пам'яті (`src/db.js`). Діаграма описує продакшн, тобто PostgreSQL.
8. **Синтаксис C4 у Mermaid досі експериментальний**, тому залежно від версії рендерера розкладка може «з'їжджати». Якщо так, параметр `UpdateLayoutConfig` можна змінити або прибрати.
