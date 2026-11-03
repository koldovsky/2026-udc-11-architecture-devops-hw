- Інструмент і модель: Claude Code 2.1.317 (`claude -p`, неінтерактивна сесія), Claude Opus 5.5 (`claude-opus-5-5`)
- Дата: 2026-11-04
- Що бачила сесія: тимчасова тека `../ws11-b-docs/` лише з `app/README.md` і `app/docs/`. Нова сесія без історії; глобального `~/.claude/CLAUDE.md` немає, пам'ять для нової теки порожня. Дозволено лише читання (Read/Grep/Glob, ls/cat/grep/find); файлів сесія не створювала.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Я розглянув лише два файли в робочій директорії: `app/README.md` і `app/docs/ARCHITECTURE.md`. Файлів, на які вони посилаються (`src/server.js`, `src/worker.js`, `bin/expire-parcels.js`, `src/config.js`, `deploy/`), тут немає. Тому діаграми побудовані за документацією (v1.5, червень 2026) і з кодом не звірені.

## Рівень 1 — System Context

```mermaid
C4Context
    title System Context — «Поштомат громади»

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку в поштоматі")
    Person(courier, "Кур'єр служби доставки", "Кладе посилку в поштомат і сканує її")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(pms, "Поштомат громади", "Реєструє посилки, сповіщає мешканців, перевіряє коди отримання, повертає посилки після 72 год")

    System_Ext(locker, "Поштомат (екран + комірки)", "Кіоск, де мешканець вводить код")
    System_Ext(scanner, "Сканер служби доставки", "Пристрій кур'єра, реєструє посилку")
    System_Ext(sms, "SMS-провайдер", "Зовнішній HTTP API для SMS")
    System_Ext(monitoring, "Система моніторингу", "Опитує стан сервісу")

    Rel(courier, scanner, "Сканує посилку")
    Rel(scanner, pms, "Реєструє посилку", "HTTP, POST /parcels")
    Rel(resident, locker, "Вводить 4-значний код")
    Rel(locker, pms, "Перевіряє код отримання", "HTTP, POST /pickup")
    Rel(staff, pms, "Переглядає посилки", "HTTP, GET /admin/parcels")
    Rel(monitoring, pms, "Перевіряє стан", "HTTP, GET /health")
    Rel(pms, sms, "Надсилає SMS з кодом", "HTTPS API")
    Rel(sms, resident, "Доставляє SMS з кодом", "SMS")

    UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Container — «Поштомат громади» (одна VM)

    Person(resident, "Мешканець")
    Person(staff, "Персонал громади")
    System_Ext(locker, "Поштомат (екран)", "Кіоск")
    System_Ext(scanner, "Сканер служби доставки")
    System_Ext(monitoring, "Система моніторингу")
    System_Ext(sms, "SMS-провайдер", "HTTP API")

    System_Boundary(vm, "VM — Поштомат громади") {
        Container(api, "API", "Node.js 22, HTTP, docker compose: api", "src/server.js — /parcels, /pickup, /admin/parcels, /health")
        Container(worker, "Worker", "Node.js 22, docker compose: worker", "src/worker.js — кожні 30 с шле SMS для посилок без сповіщення")
        Container(expire, "Нічна задача", "Node.js, запуск за розкладом", "bin/expire-parcels.js — позначає посилки старші за 72 год як повернені")
        ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза Docker", "Таблиці: посилки, події, сесії персоналу")
    }

    Rel(scanner, api, "Реєструє посилку", "HTTP POST /parcels")
    Rel(locker, api, "Надсилає код отримання", "HTTP POST /pickup")
    Rel(staff, api, "Переглядає список", "HTTP GET /admin/parcels")
    Rel(monitoring, api, "Health-check", "HTTP GET /health")

    Rel(api, db, "Читає/пише посилки, події, сесії", "SQL")
    Rel(worker, db, "Бере посилки без сповіщення, позначає сповіщені", "SQL, кожні 30 с")
    Rel(expire, db, "Позначає прострочені як повернені", "SQL, щоночі")
    Rel(worker, sms, "Надсилає SMS з кодом", "HTTPS")
    Rel(sms, resident, "SMS з кодом", "SMS")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Мої припущення

1. **Межі системи.** Екран поштомата і сканер кур'єра я вважаю зовнішніми системами-клієнтами. У README сказано «сервіс *для* поштоматів», а їхнього коду в описі немає.
2. **Хто відкриває комірку.** Документи цього не пояснюють. Я припускаю, що поштомат сам відкриває комірку, коли `POST /pickup` повертає успішну відповідь. Окремої команди від сервісу до поштомата на схемі немає.
3. **Персонал.** Припускаю, що персонал звертається до `GET /admin/parcels` напряму через браузер або HTTP-клієнт. Окремого адмін-фронтенду в документах немає, тож і контейнера для нього я не малював. Те, що в БД є таблиця сесій, означає, що API має якусь автентифікацію персоналу.
4. **Моніторинг.** У документах сказано тільки, що він «опитує `/health`». Яка це система, невідомо, тож вона зовнішня.
5. **Сховище.** На діаграмі показано продакшн із PostgreSQL. За README, у репозиторії сховище працює в пам'яті (`src/db.js`) через той самий інтерфейс. Це стосується локального запуску й тестів, тому на діаграму я його не виносив.

Синтаксис C4 у Mermaid досі експериментальний. GitHub і mermaid.live рендерять ці діаграми, але розкладку елементів підібрано вручну, тож вона може виглядати тісно.
