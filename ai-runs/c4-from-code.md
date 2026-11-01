- Tool and model: Claude Code 2.1.301 (headless, `claude -p`), claude-sonnet-5-5 (the usage report also lists claude-haiku-5-5 with ~1.2k input tokens: Claude Code's background model for auxiliary calls); run with `--restricted` (user, project and local settings ignored, so no plugins or hooks; no shell tool; file tools confined to the working folder), `--strict-mcp-config` (no MCP servers), `--disable-slash-commands` (no skills), `--no-session-persistence`, auto-memory disabled; no global CLAUDE.md exists
- Date: 2026-10-30
- What the session saw: temporary folder ../ws11-b-code containing a copy of the whole `app/`
- Prompt (verbatim):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Я прочитав код і `docs/ARCHITECTURE.md`. Діаграми побудовані за кодом, а не лише за документом, бо вони розходяться (деталі нижче).

## Рівень 1: System Context

```mermaid
C4Context
    title Поштомат громади — System Context

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з поштомата")
    Person(staff, "Персонал громади", "Переглядає список посилок")
    Person(courierStaff, "Працівник служби доставки", "Кладе посилки в поштомат і реєструє їх сканером")

    System(poshtomat, "Поштомат громади", "Реєструє посилки, сповіщає мешканців SMS-кодом, видає посилки за кодом, повертає прострочені")

    System_Ext(sms, "SMS-провайдер", "HTTP API надсилання SMS")
    System_Ext(courier, "Служба доставки (Returns API)", "Забирає невитребувані посилки і повертає відправнику")
    System_Ext(monitoring, "Моніторинг", "Опитує health-check")

    Rel(courierStaff, poshtomat, "Реєструє посилку", "сканер, HTTP/JSON")
    Rel(resident, poshtomat, "Вводить код на екрані поштомата", "HTTP/JSON")
    Rel(staff, poshtomat, "Дивиться список посилок", "HTTP/JSON, Bearer-сесія")
    Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTPS, Bearer-токен")
    Rel(poshtomat, courier, "Просить забрати прострочену посилку", "HTTPS/JSON")
    Rel(monitoring, poshtomat, "GET /health", "HTTP")
    Rel(sms, resident, "Доставляє SMS з кодом", "SMS")
```

## Рівень 2: Container

```mermaid
C4Container
    title Поштомат громади — Containers (одна VM)

    Person(resident, "Мешканець")
    Person(staff, "Персонал громади")
    Person(courierStaff, "Працівник служби доставки")
    System_Ext(monitoring, "Моніторинг")
    System_Ext(sms, "SMS-провайдер", "HTTP API")
    System_Ext(courier, "Служба доставки", "Returns API")

    System_Boundary(vm, "Одна VM") {
        Container(screen, "Екран поштомата", "клієнт на пристрої", "Приймає код від мешканця")
        Container(scanner, "Сканер служби доставки", "клієнт на пристрої", "Реєструє посилки")
        Container(api, "API", "Node.js 22, HTTP, docker compose (сервіс api)", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health; авторизація персоналу за сесією в БД")
        Container(worker, "Worker", "Node.js, docker compose (сервіс worker)", "Опитує БД кожні 10 с, шле SMS з 4-значним кодом, ліміт 5 SMS/с, ретраї при 429")
        Container(cron, "Нічна задача expire-parcels", "Node.js, cron на VM", "Позначає посилки старші за 72 год як повернені і просить службу доставки їх забрати")
        ContainerDb(db, "PostgreSQL", "поза контейнерами, на тій самій VM", "Посилки, події, сесії персоналу")
    }

    Rel(resident, screen, "Вводить код")
    Rel(courierStaff, scanner, "Сканує посилку")
    Rel(screen, api, "POST /pickup", "HTTP/JSON")
    Rel(scanner, api, "POST /parcels", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels", "HTTP/JSON, Bearer")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає/пише посилки, перевіряє сесії", "пул з'єднань")
    Rel(worker, db, "Читає непосповіщені, ставить notifiedAt", "пул з'єднань")
    Rel(cron, db, "Знаходить прострочені, ставить статус «повернено»", "пул з'єднань")

    Rel(worker, sms, "POST /messages", "HTTPS, Bearer")
    Rel(cron, courier, "POST /returns", "HTTPS/JSON")
```

## Припущення

1. **«Ця система»** — це сервіс у `app/` (проєкт «Поштомат громади»). Інших систем у директорії немає.
2. **Екран поштомата і сканер** — окремі клієнти, їхнього коду в репозиторії немає. Я намалював їх як контейнери-клієнти за описом у `ARCHITECTURE.md`. Де вони працюють фізично (на поштоматі чи на пристрої кур'єра), невідомо.
3. **PostgreSQL.** У репозиторії є лише in-memory реалізація `src/db.js`. За README у продакшні той самий інтерфейс працює поверх PostgreSQL, тож на діаграмі він є.
4. **Моніторинг** — зовнішня система, яка опитує `GET /health`. Що саме це за система, у коді не сказано.
5. **Нічна задача** запускається cron-ом на VM. Це видно з коментаря в `bin/expire-parcels.js`, а не з `deploy/`, якого в наданій директорії немає.

## Розбіжності між документацією і кодом

- **Інтервал worker-а.** У `ARCHITECTURE.md` написано «кожні 30 секунд». У `src/worker.js` `POLL_INTERVAL_MS = 10_000`, тобто 10 с. На діаграмі стоїть 10 с.
- **Служба доставки як приймач.** Документ згадує службу доставки лише як джерело (сканер). Але `src/courier.js` і нічна задача викликають її Returns API (`POST /returns`). Тому на діаграмах вона є і джерелом, і зовнішньою системою, до якої йдуть виклики.
- **Версія.** Документ каже v1.5, а `package.json` — 1.7.3. `ARCHITECTURE.md` варто оновити.
