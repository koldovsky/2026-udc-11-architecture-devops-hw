- Інструмент і модель: Claude Code CLI 2.1.304, headless-режим (`claude -p`, дозволені лише інструменти Read/Grep/Glob/LS), модель claude-sonnet-4-6
- Дата: 2026-10-26
- Що бачила сесія: тимчасова тека `../ws11-b-docs/` поруч із репо — лише `app/README.md` і `app/docs/ARCHITECTURE.md`. Нова сесія без історії й без підказок; глобального `~/.claude/CLAUDE.md` немає, у батьківських теках CLAUDE.md / AGENTS.md немає. Сесію запустив агент (GitHub Copilot) з терміналу; нижче — фінальна відповідь сесії (`result` з JSON-виводу) без змін.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Ось C4-діаграми в Mermaid.

---

**Припущення:**
- «Екран поштомата» — вбудований клієнт апаратного пристрою (поза межами програмної системи), він викликає API по HTTP.
- «Служба доставки» — мобільний сканер або сторонній клієнт (теж зовнішній).
- Персонал звертається до `GET /admin/parcels` безпосередньо (CLI / Postman / окремий UI — в документації не вказано, тому вважаємо зовнішнім актором без окремого контейнера).
- Worker і Expire Task читають БД самостійно (не через API).

---

## Рівень 1 — System Context

```mermaid
C4Context
  title System Context — Поштомат громади

  Person(resident,  "Мешканець",        "Отримує SMS з кодом і забирає посилку з поштомата")
  Person(delivery,  "Служба доставки",  "Сканер реєструє нову посилку")
  Person(admin,     "Персонал",         "Переглядає список посилок")

  System(system, "Поштомат громади", "Реєструє посилки, надсилає SMS-коди, підтверджує самовивіз, автоматично повертає прострочені посилки")

  System_Ext(lockerScreen, "Екран поштомата", "Вбудований клієнт пристрою; відображає форму введення коду")
  System_Ext(smsProvider,  "SMS-провайдер",   "Зовнішній HTTP API для надсилання SMS-повідомлень")

  Rel(delivery,     system,       "Реєструє посилку",            "POST /parcels · HTTP")
  Rel(admin,        system,       "Переглядає посилки",          "GET /admin/parcels · HTTP")
  Rel(resident,     lockerScreen, "Вводить код отримання")
  Rel(lockerScreen, system,       "Підтверджує видачу посилки",  "POST /pickup · HTTP")
  Rel(system,       smsProvider,  "Надсилає SMS з кодом",        "HTTP API")
  Rel(system,       resident,     "SMS: код отримання")
```

---

## Рівень 2 — Container

```mermaid
C4Container
  title Container — Поштомат громади

  Person(resident,  "Мешканець",        "Отримує SMS, вводить код")
  Person(delivery,  "Служба доставки",  "Сканер реєструє посилку")
  Person(admin,     "Персонал",         "Адмін-перегляд")

  System_Ext(lockerScreen, "Екран поштомата", "Вбудований клієнт пристрою")
  System_Ext(smsProvider,  "SMS-провайдер",   "Зовнішній HTTP API")

  System_Boundary(sb, "Поштомат громади") {
    Container(api,    "API Server",   "Node.js · src/server.js",           "Обробляє HTTP-запити: POST /parcels, POST /pickup, GET /admin/parcels, GET /health")
    Container(worker, "Worker",       "Node.js · src/worker.js",           "Кожні 30 с вибирає посилки без сповіщення і надсилає SMS з 4-значним кодом")
    Container(expire, "Expire Task",  "Node.js · bin/expire-parcels.js",   "Нічна задача: позначає посилки, що пролежали >72 год, як повернені")
    ContainerDb(db,   "PostgreSQL",   "RDBMS · поза Docker, на тій самій VM", "Таблиці: посилки, події, сесії персоналу")
  }

  Rel(delivery,     api,         "POST /parcels",                    "HTTP")
  Rel(lockerScreen, api,         "POST /pickup",                     "HTTP")
  Rel(resident,     lockerScreen,"Вводить код")
  Rel(admin,        api,         "GET /admin/parcels",               "HTTP")

  Rel(api,          db,          "Читає / пише",                     "SQL")
  Rel(worker,       db,          "Вибирає посилки без сповіщення",   "SQL")
  Rel(worker,       smsProvider, "Надсилає SMS",                     "HTTP API")
  Rel(smsProvider,  resident,    "SMS: код отримання")
  Rel(expire,       db,          "Оновлює статус → повернено",       "SQL")
```

---

**Ключові спостереження по діаграмах:**
- Worker і API — окремі процеси з одного Docker-образу; обидва тримають пряме з'єднання з PostgreSQL (немає черги повідомлень — потенційне місце ризику при масштабуванні).
- Expire Task запускається окремо (cron / ручний запуск) і не проходить через API — пряма залежність від БД.
- SMS-провайдер — єдина зовнішня залежність на рівні контейнерів.
