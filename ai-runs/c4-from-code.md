- Інструмент і модель: Claude Code CLI 2.1.304, headless-режим (`claude -p`, дозволені лише інструменти Read/Grep/Glob/LS), модель claude-sonnet-4-6
- Дата: 2026-10-26
- Що бачила сесія: тимчасова тека `../ws11-b-code/` поруч із репо — уся копія `app/`. Нова сесія без історії й без підказок; глобального `~/.claude/CLAUDE.md` немає, у батьківських теках CLAUDE.md / AGENTS.md немає. Сесію запустив агент (GitHub Copilot) з терміналу; нижче — фінальна відповідь сесії (`result` з JSON-виводу) без змін.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Маю достатньо інформації. Ось C4-діаграми:

---

## C4 Level 1 — System Context

**Припущення:** поштомат має власний екран/кіоск як окрему точку взаємодії; служба доставки має свій сканер; SMS-провайдер та API служби доставки (повернення) — зовнішні SaaS-системи.

```mermaid
C4Context
  title System Context — Поштомат громади

  Person(resident, "Мешканець", "Отримує посилку, вводячи код на екрані поштомата")
  Person(courier_staff, "Служба доставки", "Сканує посилку при закладанні в поштомат")
  Person(admin, "Персонал поштомата", "Переглядає список посилок через адмін-інтерфейс")

  System(poshtomat, "Поштомат громади", "Реєструє посилки, надсилає SMS-коди мешканцям, керує поверненнями")

  System_Ext(locker_screen, "Екран поштомата", "Кіоск / термінал: мешканець вводить код і відкриває комірку")
  System_Ext(courier_api, "API служби доставки", "Зовнішній HTTP API для ініціювання повернення посилки відправнику")
  System_Ext(sms_provider, "SMS-провайдер", "Зовнішній HTTP API для відправки SMS")

  Rel(courier_staff, poshtomat, "Реєструє посилку", "HTTP POST /parcels")
  Rel(resident, locker_screen, "Вводить код отримання")
  Rel(locker_screen, poshtomat, "Надсилає код для перевірки", "HTTP POST /pickup")
  Rel(admin, poshtomat, "Переглядає посилки", "HTTP GET /admin/parcels")
  Rel(poshtomat, sms_provider, "Надсилає SMS з кодом мешканцю", "HTTPS POST /messages")
  Rel(poshtomat, courier_api, "Запитує повернення прострочених посилок", "HTTPS POST /returns")
```

---

## C4 Level 2 — Container

**Припущення:** `docker compose` запускає `api` і `worker` як окремі контейнери з одного образу; PostgreSQL розгорнуто на тій самій VM поза Docker; `expire-parcels` запускається cron-ом безпосередньо на VM (не в контейнері).

```mermaid
C4Container
  title Container — Поштомат громади (одна VM)

  Person(courier_staff, "Служба доставки")
  Person(resident_screen, "Екран поштомата")
  Person(admin, "Персонал поштомата")

  System_Ext(sms_provider, "SMS-провайдер", "Зовнішній HTTP API")
  System_Ext(courier_api, "API служби доставки", "Зовнішній HTTP API")

  System_Boundary(vm, "VM (Docker Compose)") {
    Container(api, "API Container", "Node.js 22, HTTP :8080", "Обробляє реєстрацію посилок, видачу за кодом, адмін-список та /health")
    Container(worker, "Worker Container", "Node.js 22, poll loop 10s", "Опитує БД на нові посилки, надсилає SMS з кодом отримання")
    ContainerDb(db, "PostgreSQL", "PostgreSQL на VM (поза Docker)", "Таблиці: parcels, events, sessions")
    Container(cron_job, "expire-parcels", "Node.js скрипт, cron на VM (нічний запуск)", "Позначає посилки >72h як повернені та викликає API служби доставки")
  }

  Rel(courier_staff, api, "POST /parcels — реєстрація посилки", "HTTP JSON")
  Rel(resident_screen, api, "POST /pickup — перевірка коду", "HTTP JSON")
  Rel(admin, api, "GET /admin/parcels", "HTTP JSON + Bearer token")

  Rel(api, db, "Читає/записує посилки, сесії", "SQL (DB pool)")
  Rel(worker, db, "Читає непосповіщені посилки, оновлює notifiedAt", "SQL (DB pool)")
  Rel(cron_job, db, "Знаходить прострочені, позначає returned", "SQL (DB pool)")

  Rel(worker, sms_provider, "POST /messages — SMS з кодом", "HTTPS JSON, Bearer token, rate-limited 5/s")
  Rel(cron_job, courier_api, "POST /returns — запит на повернення", "HTTPS JSON")
```

---

**Ключові припущення, зроблені явно:**

| # | Припущення |
|---|---|
| 1 | Екран поштомата — окрема зовнішня система (кіоск), а не частина цього backend-у |
| 2 | PostgreSQL стоїть на VM поза Docker-контейнерами (як написано в ARCHITECTURE.md) |
| 3 | `expire-parcels` запускається cron-ом на VM, не всередині контейнера |
| 4 | `COURIER_BASE_URL` в конфігу — це окремий зовнішній API (не той самий `api`-контейнер) |
| 5 | Авторизація між службою доставки та API — не задокументована; показано без автентифікації |
