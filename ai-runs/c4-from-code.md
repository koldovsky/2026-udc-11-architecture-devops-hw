- Інструмент і модель: Claude Code 2.1.316 (headless `claude -p --model sonnet`), claude-sonnet-5-5
- Дата: 2026-11-02
- Що бачила сесія: тимчасова тека `../ws11-b-code/`: уся копія `app/`. Нова сесія (окремий процес), без історії; інструменти лише на читання (`Read, Glob, Grep, Bash`). Глобального `~/.claude/CLAUDE.md` немає; пам'ять Claude Code прив'язана до теки проєкту, для тимчасової теки вона порожня
- Вартість прогону: 11 ходів, 10 викликів інструментів (Glob × 1, Read × 9), $0.117, 25 с
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Нижче — дві C4-діаграми (System Context і Container) за кодом у `app/`.

## Припущення

- **Межа системи** — сервіс «Поштомат громади» (`poshtomat`). Екран поштомата, сканер служби доставки й адмін-інтерфейс персоналу вважаю зовнішніми клієнтами API. У репозиторії їхнього коду немає.
- **Нічна задача** (`bin/expire-parcels.js`) окремо від `api` і `worker`. Це cron на VM, а не сервіс у `docker compose`.
- **Служба доставки** виступає у двох ролях. Її сканер реєструє посилки через `POST /parcels`. Її Returns API приймає запити на повернення (`courier.js`). У `ARCHITECTURE.md` другу роль не названо, але код її має.
- **Моніторинг** опитує `GET /health`. Що саме це за система, невідомо, тому показую її як зовнішню.
- **PostgreSQL** розташований на тій самій VM поза контейнерами. Так сказано в документації. У цьому репозиторії замість нього in-memory `db.js` з тим самим інтерфейсом.
- **Шлях `deploy/`** згаданий у документації, але в робочій директорії його немає, тому деталей розгортання не малюю.

## Рівень 1 — System Context

```mermaid
C4Context
    title System Context — Поштомат громади

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з поштомата")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(poshtomat, "Поштомат громади", "Реєструє посилки, розсилає SMS з кодами, видає посилки за кодом, повертає прострочені")

    System_Ext(locker, "Екран поштомата", "Пристрій, де мешканець вводить код")
    System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку при завантаженні в поштомат")
    System_Ext(courier, "Служба доставки (Returns API)", "Забирає невитребувані посилки назад відправнику")
    System_Ext(sms, "SMS-провайдер", "HTTP API для надсилання SMS")
    System_Ext(monitoring, "Моніторинг", "Опитує health-endpoint")

    Rel(resident, locker, "Вводить код")
    Rel(locker, poshtomat, "Надсилає код отримання", "HTTP/JSON")
    Rel(scanner, poshtomat, "Реєструє посилку", "HTTP/JSON")
    Rel(staff, poshtomat, "Переглядає посилки", "HTTP/JSON, Bearer-сесія")
    Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTPS/JSON")
    Rel(sms, resident, "Доставляє SMS")
    Rel(poshtomat, courier, "Запитує повернення посилки", "HTTPS/JSON")
    Rel(monitoring, poshtomat, "GET /health", "HTTP")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Container — Поштомат громади (одна VM)

    Person(staff, "Персонал громади", "")
    System_Ext(locker, "Екран поштомата", "")
    System_Ext(scanner, "Сканер служби доставки", "")
    System_Ext(monitoring, "Моніторинг", "")
    System_Ext(sms, "SMS-провайдер", "HTTP API")
    System_Ext(courier, "Служба доставки (Returns API)", "")

    System_Boundary(vm, "Одна VM") {
        Container(api, "API", "Node.js 22, HTTP, docker compose", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health; авторизація персоналу за Bearer-сесією")
        Container(worker, "Worker", "Node.js 22, docker compose, той самий образ", "Опитує БД, шле SMS з кодом про нові посилки, rate-limit і retry на 429")
        Container(expire, "Нічна задача expire-parcels", "Node.js, cron на VM", "Позначає посилки старші за 72 год як повернені й просить службу доставки забрати їх")
        ContainerDb(db, "PostgreSQL", "PostgreSQL, на VM поза контейнерами", "Посилки, події, сесії персоналу")
    }

    Rel(locker, api, "POST /pickup", "HTTP/JSON")
    Rel(scanner, api, "POST /parcels", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels", "HTTP/JSON, Bearer")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає й пише посилки, перевіряє сесії", "SQL, пул з'єднань")
    Rel(worker, db, "Читає непосповіщені посилки, ставить notifiedAt", "SQL, пул з'єднань")
    Rel(expire, db, "Знаходить прострочені, ставить статус «повернено»", "SQL, пул з'єднань")

    Rel(worker, sms, "POST /messages", "HTTPS/JSON, Bearer-токен")
    Rel(expire, courier, "POST /returns", "HTTPS/JSON")
```

## Розбіжності між документацією і кодом

- **Інтервал worker.** У `ARCHITECTURE.md` написано «кожні 30 секунд», а в `worker.js:8` `POLL_INTERVAL_MS = 10_000`, тобто 10 секунд. Якщо повний батч (50), worker іде на наступний раунд одразу. На діаграмах інтервал не вказую.
- **Виклик Returns API.** Документація його не згадує, але нічна задача його робить (`expire-parcels.js:15`). Тому на діаграмі є зовнішня система «Служба доставки (Returns API)».
- **Версія.** `ARCHITECTURE.md` каже v1.5, а `package.json` — 1.7.3. Схоже, документація не оновлювалась.
