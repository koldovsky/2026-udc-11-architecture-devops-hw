- Інструмент і модель: Claude Code (headless: `claude -p`), модель за замовчуванням, не закріплена
- Дата: 2026-11-03
- Що бачила сесія: тимчасова тека `ws11-b-code` з усією `app/` (разом з `app/README.md` і `app/docs/`). Пам'ять вимкнено (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), нова сесія без історії (`--no-session-persistence`), інструменти лише Read/Grep/Glob. **Лишався ввімкненим глобальний `~/.claude/CLAUDE.md`** (лише правила щодо git-комітів); `--bare` не використано — немає ANTHROPIC_API_KEY.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче дві діаграми: System Context і Container. Я зробив їх із коду `src/` і `bin/`, а не з `docs/ARCHITECTURE.md`, бо документ розходиться з кодом (деталі в кінці).

## Припущення

- **Екран поштомата й сканер служби доставки** — зовнішні клієнти. У репозиторії їхнього коду немає, вони лише викликають API.
- **Служба доставки** — одна зовнішня сторона. Вона реєструє посилки через сканер і приймає запити на повернення через Returns API (`courier.js`).
- **Моніторинг** опитує `GET /health`. Що саме це за система, у коді не видно.
- **PostgreSQL** — продакшн-сховище. У репозиторії є лише in-memory реалізація `db.js` з тим самим інтерфейсом. Про Postgres відомо з `ARCHITECTURE.md` і README.
- **Нічна задача** працює як cron на VM, поза `docker compose`. Так сказано в `bin/expire-parcels.js`. Чи запускається вона з того самого образу, невідомо.
- **Сесії персоналу** читаються з БД (`findSession`), але код, що їх створює, у репозиторії відсутній. Тому на діаграмі їх ніхто не створює.

## Рівень 1: System Context

```mermaid
C4Context
    title Поштомат громади — System Context

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(poshtomat, "Поштомат громади", "Реєструє посилки, сповіщає отримувачів, видає посилки за кодом, повертає непотребувані")

    System_Ext(locker, "Екран поштомата", "Термінал, де мешканець вводить код")
    System_Ext(courier, "Служба доставки", "Сканер реєструє посилки; Returns API приймає повернення")
    System_Ext(sms, "SMS-провайдер", "HTTP API для надсилання SMS")
    System_Ext(monitoring, "Моніторинг", "Опитує health-check")

    Rel(resident, locker, "Вводить код")
    Rel(resident, sms, "Отримує SMS з кодом")
    Rel(locker, poshtomat, "Надсилає код отримання", "HTTP/JSON")
    Rel(courier, poshtomat, "Реєструє посилку", "HTTP/JSON")
    Rel(staff, poshtomat, "Дивиться список посилок", "HTTP/JSON, Bearer-сесія")
    Rel(monitoring, poshtomat, "Опитує /health", "HTTP")
    Rel(poshtomat, sms, "Надсилає SMS про прибуття", "HTTP/JSON, Bearer-токен")
    Rel(poshtomat, courier, "Просить забрати непотребувану посилку", "HTTP/JSON")
```

## Рівень 2: Container

```mermaid
C4Container
    title Поштомат громади — Container

    Person(staff, "Персонал громади")

    System_Ext(locker, "Екран поштомата", "Вводить код отримання")
    System_Ext(scanner, "Сканер служби доставки", "Реєструє посилки")
    System_Ext(monitoring, "Моніторинг")
    System_Ext(sms, "SMS-провайдер", "HTTP API /messages")
    System_Ext(courierApi, "Courier Returns API", "HTTP API /returns")

    System_Boundary(vm, "Одна VM") {
        Container(api, "API", "Node.js 22, HTTP, docker compose", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health; валідація, ролі staff/admin, маскування телефонів")
        Container(worker, "Worker", "Node.js 22, docker compose", "Раз на 10 с бере до 50 посилок без сповіщення і шле SMS; ліміт 5 SMS/с, ретраї на 429")
        Container(expire, "Нічна задача expire-parcels", "Node.js 22, cron на VM", "Позначає посилки старші за 72 год як повернені й просить службу доставки їх забрати")
        ContainerDb(db, "PostgreSQL", "Реляційна БД, поза контейнерами", "Посилки, події, сесії персоналу")
    }

    Rel(scanner, api, "POST /parcels", "HTTP/JSON")
    Rel(locker, api, "POST /pickup", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels", "HTTP/JSON, Bearer")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає/пише посилки, події; перевіряє сесії", "пул з'єднань, max 4")
    Rel(worker, db, "Читає непросповіщені, ставить notifiedAt", "пул з'єднань")
    Rel(expire, db, "Знаходить прострочені, ставить status=returned", "пул з'єднань")

    Rel(worker, sms, "Надсилає SMS з кодом", "HTTP/JSON, Bearer")
    Rel(expire, courierApi, "Запит на повернення", "HTTP/JSON")
```

## Де `ARCHITECTURE.md` розходиться з кодом

- **Courier Returns API відсутній у документі.** Нічна задача викликає зовнішню службу (`courier.js`, `COURIER_BASE_URL`), а в схемі документа зовнішня система лише одна, SMS-провайдер.
- **Інтервал worker.** У документі 30 секунд, у коді `POLL_INTERVAL_MS = 10_000`.
- **Довжина коду.** У документі 4 цифри, у коді 6 (`parcels.js`).
- **Каталог `deploy/`.** Документ посилається на нього, але в цьому репозиторії його немає. Тому розкладку на `docker compose` і cron я взяв із тексту документа, а не з конфігурації.
- **Нічна задача.** Документ не пише, що вона працює через cron, а не в контейнері. Це видно лише з коментаря в `bin/expire-parcels.js`.
