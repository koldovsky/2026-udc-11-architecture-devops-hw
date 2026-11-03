- Інструмент і модель: Claude Code (Workflow-субагент general-purpose), Claude Fable 5 (`claude-fable-5`)
- Дата: 2026-11-03
- Що бачила сесія: тимчасова тека ../ws11-b-docs — лише `app/README.md` і `app/docs/`. Прогін запускався субагентом із сесії в корені репо, тому субагенту системно підвантажувався `CLAUDE.md` репо (він посилається на `AGENTS.md`); агенту явно вказано читати лише тимчасову теку. Пам'ять між сесіями в субагентів відсутня; відповідь нижче — перша, дослівно.
- Промпт (дослівно):

  > Твоя робоча тека: C:/Users/777ma/IdeaProjects/ws11-b-docs — це корінь проєкту. Читай лише файли в цій теці й не зазирай в інші теки.
  >
  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Я прочитав обидва файли в робочій теці (`C:/Users/777ma/IdeaProjects/ws11-b-docs/app/README.md` та `C:/Users/777ma/IdeaProjects/ws11-b-docs/app/docs/ARCHITECTURE.md`) — інших файлів у теці немає. Нижче — C4-діаграми рівнів System Context і Container у Mermaid.

## Припущення (у теці лише README та ARCHITECTURE.md, коду немає)

1. **Система** = бекенд-сервіс «Поштомат громади» (API, worker, нічна задача, PostgreSQL). ПЗ екрана поштомата і сканер служби доставки — окремі клієнтські системи/пристрої поза цим репозиторієм, тому моделюю їх як зовнішні системи.
2. **Персонал** дивиться `GET /admin/parcels` через браузер/HTTP-клієнт з авторизацією (в БД є таблиця «сесії персоналу»).
3. **Нічна задача** `bin/expire-parcels.js` запускається планувальником (cron) на VM — механізм запуску в документах не вказано.
4. **Моніторинг** — зовнішня система, що опитує `GET /health` (яка саме — не вказано).
5. Діаграми показують **продакшн-вигляд**: сховище — PostgreSQL на тій самій VM поза контейнерами (у репозиторії для розробки — in-memory `src/db.js` з тим самим інтерфейсом).
6. API і Worker — два сервіси `docker compose` з одного образу на одній VM (за розділом «Розгортання»); worker не має HTTP-інтерфейсу, він опитує БД кожні 30 с.
7. SMS-провайдер надає HTTP API; worker шле через нього SMS із 4-значним кодом мешканцю.

## Рівень 1 — System Context

```mermaid
C4Context
    title Поштомат громади — System Context (C4, рівень 1)

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку, ввівши код на екрані поштомата")
    Person(courier, "Кур'єр служби доставки", "Реєструє посилку в поштоматі через сканер")
    Person(staff, "Персонал", "Переглядає список посилок, обслуговує поштомати")

    System(pochtomat, "Поштомат громади", "Бекенд-сервіс: реєстрація посилок, коди отримання, SMS-сповіщення, повернення прострочених посилок")

    System_Ext(screen, "Екран поштомата", "ПЗ на пристрої поштомата: приймає код отримання від мешканця")
    System_Ext(scanner, "Сканер служби доставки", "Клієнтський застосунок кур'єра для реєстрації посилок")
    System_Ext(smsProvider, "SMS-провайдер", "Зовнішній сервіс розсилання SMS (HTTP API)")
    System_Ext(monitoring, "Моніторинг", "Опитує стан сервісу")

    Rel(resident, screen, "Вводить 4-значний код отримання")
    Rel(courier, scanner, "Сканує та реєструє посилку")
    Rel(staff, pochtomat, "Переглядає список посилок", "HTTPS, GET /admin/parcels")

    Rel(screen, pochtomat, "Надсилає код отримання", "HTTP, POST /pickup")
    Rel(scanner, pochtomat, "Реєструє посилку", "HTTP, POST /parcels")
    Rel(pochtomat, smsProvider, "Надсилає запит на SMS з кодом", "HTTP API")
    Rel(smsProvider, resident, "Доставляє SMS з кодом отримання", "SMS")
    Rel(monitoring, pochtomat, "Перевіряє стан", "HTTP, GET /health")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Поштомат громади — Container (C4, рівень 2). Розгортання: одна VM, docker compose

    Person(resident, "Мешканець", "Забирає посилку за кодом із SMS")
    Person(courier, "Кур'єр служби доставки", "Реєструє посилку")
    Person(staff, "Персонал", "Переглядає список посилок")

    System_Ext(screen, "Екран поштомата", "Пристрій поштомата")
    System_Ext(scanner, "Сканер служби доставки", "Клієнт кур'єра")
    System_Ext(smsProvider, "SMS-провайдер", "HTTP API розсилання SMS")
    System_Ext(monitoring, "Моніторинг", "Опитує GET /health")

    System_Boundary(vm, "Поштомат громади — одна VM") {
        Container(api, "API", "Node.js, src/server.js (контейнер docker compose)", "HTTP API: POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Конфіг зі змінних оточення (src/config.js)")
        Container(worker, "Worker", "Node.js, src/worker.js (контейнер docker compose, той самий образ)", "Кожні 30 с бере посилки без сповіщення і шле SMS з 4-значним кодом через SMS-провайдера")
        Container(expire, "Нічна задача", "Node.js, bin/expire-parcels.js (запуск за розкладом, припущення: cron)", "Позначає посилки, що пролежали понад 72 години, як повернені")
        ContainerDb(db, "PostgreSQL", "СУБД на тій самій VM, поза контейнерами", "Таблиці: посилки, події, сесії персоналу. У dev — in-memory src/db.js з тим самим інтерфейсом")
    }

    Rel(resident, screen, "Вводить код отримання")
    Rel(courier, scanner, "Сканує посилку")
    Rel(screen, api, "POST /pickup", "HTTP")
    Rel(scanner, api, "POST /parcels", "HTTP")
    Rel(staff, api, "GET /admin/parcels", "HTTP, сесії персоналу")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає/пише посилки, події, сесії", "SQL")
    Rel(worker, db, "Опитує посилки без сповіщення, фіксує відправлення", "SQL, кожні 30 с")
    Rel(expire, db, "Позначає посилки >72 год як повернені", "SQL, щоночі")
    Rel(worker, smsProvider, "Надсилає SMS з кодом отримання", "HTTP API")
    Rel(smsProvider, resident, "SMS з 4-значним кодом", "SMS")
```

### Короткі пояснення

- **System Context**: три ролі людей (мешканець, кур'єр, персонал), одна система «Поштомат громади» та чотири зовнішні системи (екран поштомата, сканер, SMS-провайдер, моніторинг). Межу системи проведено по репозиторію: клієнтські пристрої — зовні (припущення 1).
- **Container**: усередині межі — чотири контейнери в сенсі C4: `API` і `Worker` (два docker-compose-сервіси з одного образу), `Нічна задача` (скрипт за розкладом) і `PostgreSQL` (на тій самій VM, поза Docker). Усі три процеси спілкуються лише через спільну БД; єдиний вихідний інтеграційний канал — HTTP API SMS-провайдера з боку Worker.

Джерела: `C:/Users/777ma/IdeaProjects/ws11-b-docs/app/README.md`, `C:/Users/777ma/IdeaProjects/ws11-b-docs/app/docs/ARCHITECTURE.md`. Файлів не створював.
