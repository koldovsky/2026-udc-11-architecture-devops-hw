- Tool and model: Claude Code 2.1.301 (headless, `claude -p`), claude-sonnet-5-5 (the usage report also lists claude-haiku-5-5 with ~1.2k input tokens: Claude Code's background model for auxiliary calls); run with `--restricted` (user, project and local settings ignored, so no plugins or hooks; no shell tool; file tools confined to the working folder), `--strict-mcp-config` (no MCP servers), `--disable-slash-commands` (no skills), `--no-session-persistence`, auto-memory disabled; no global CLAUDE.md exists
- Date: 2026-10-30
- What the session saw: temporary folder ../ws11-b-docs containing only `app/README.md` and `app/docs/ARCHITECTURE.md`
- Prompt (verbatim):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Я прочитав лише `README.md` і `docs/ARCHITECTURE.md`. Каталогів `src/`, `bin/` та `deploy/` у робочій теці немає, тому діаграми побудовані на документації (v1.5, червень 2026), а не на коді.

## Припущення

- Нічна задача `expire-parcels` запускається планувальником на VM (cron або подібним). У документації про це не сказано.
- Персонал працює з `GET /admin/parcels` через HTTP. Як саме вони автентифікуються, невідомо. Таблиця «сесії персоналу» лише натякає, що сесії є.
- Моніторинг — зовнішня система, яка опитує `GET /health`. Назви конкретного продукту немає.
- Екран поштомата й сканер служби доставки — клієнти API. Я показав їх як окремі акторів/системи, а не контейнери всередині цієї системи.
- Потік «SMS мешканцю» йде через зовнішнього SMS-провайдера. Мобільного застосунку чи інших каналів немає.
- Протокол до PostgreSQL не вказано. Я позначив його як SQL/TCP.
- Нічна задача ходить у БД напряму, а не через API. У README це окремий скрипт `bin/`.

## Рівень 1: System Context

```mermaid
C4Context
    title System Context — Поштомат громади

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(parcelSystem, "Поштомат громади", "Реєструє посилки, сповіщає мешканців SMS, видає посилки за кодом")

    System_Ext(locker, "Екран поштомата", "Пристрій, де мешканець вводить код")
    System_Ext(courier, "Сканер служби доставки", "Реєструє посилки при завантаженні")
    System_Ext(sms, "SMS-провайдер", "HTTP API для надсилання SMS")
    System_Ext(monitoring, "Моніторинг", "Опитує health-check")

    Rel(resident, locker, "Вводить код отримання")
    Rel(locker, parcelSystem, "Надсилає код", "HTTP: POST /pickup")
    Rel(courier, parcelSystem, "Реєструє посилку", "HTTP: POST /parcels")
    Rel(staff, parcelSystem, "Переглядає посилки", "HTTP: GET /admin/parcels")
    Rel(monitoring, parcelSystem, "Перевіряє стан", "HTTP: GET /health")
    Rel(parcelSystem, sms, "Надсилає SMS з кодом", "HTTP API")
    Rel(sms, resident, "Доставляє SMS з кодом")
```

## Рівень 2: Container

```mermaid
C4Container
    title Container — Поштомат громади (одна VM)

    Person(resident, "Мешканець", "Отримує SMS, вводить код")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System_Ext(locker, "Екран поштомата", "Вводить код отримання")
    System_Ext(courier, "Сканер служби доставки", "Реєструє посилки")
    System_Ext(monitoring, "Моніторинг", "Health-check")
    System_Ext(sms, "SMS-провайдер", "HTTP API для SMS")

    System_Boundary(vm, "Поштомат громади — одна VM") {
        Container(api, "API", "Node.js, HTTP (docker compose: api)", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health")
        Container(worker, "Worker", "Node.js (docker compose: worker, той самий образ)", "Кожні 30 с бере посилки без сповіщення, шле SMS з 4-значним кодом")
        Container(expire, "Нічна задача", "Node.js, bin/expire-parcels.js", "Позначає посилки старші за 72 год як повернені")
        ContainerDb(db, "PostgreSQL", "PostgreSQL, на VM поза контейнерами", "Посилки, події, сесії персоналу")
    }

    Rel(resident, locker, "Вводить код")
    Rel(locker, api, "Надсилає код", "HTTP: POST /pickup")
    Rel(courier, api, "Реєструє посилку", "HTTP: POST /parcels")
    Rel(staff, api, "Переглядає посилки", "HTTP: GET /admin/parcels")
    Rel(monitoring, api, "Опитує", "HTTP: GET /health")

    Rel(api, db, "Читає/пише", "SQL/TCP")
    Rel(worker, db, "Вибирає посилки без сповіщення, відмічає надіслане", "SQL/TCP")
    Rel(expire, db, "Оновлює статус прострочених", "SQL/TCP")
    Rel(worker, sms, "Надсилає SMS з кодом", "HTTP API")
    Rel(sms, resident, "Доставляє SMS")
```

## Що варто звірити

- Чи актуальна документація: якщо у `src/` з'явилися нові інтеграції чи сервіси, діаграми треба оновити.
- Спосіб запуску нічної задачі (cron на VM чи окремий контейнер). Від цього залежить, чи малювати її всередині `docker compose`.
