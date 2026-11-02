- Інструмент і модель: Claude Code 2.1.316 (headless `claude -p --model sonnet`), claude-sonnet-5-5
- Дата: 2026-11-02
- Що бачила сесія: тимчасова тека `../ws11-b-docs/`: лише `app/README.md` і `app/docs/`. Нова сесія (окремий процес), без історії; інструменти лише на читання (`Read, Glob, Grep, Bash`). Глобального `~/.claude/CLAUDE.md` немає; пам'ять Claude Code прив'язана до теки проєкту, для тимчасової теки вона порожня
- Вартість прогону: 4 ходів, 3 викликів інструментів (Glob × 1, Read × 2), $0.079, 29 с
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
У теці є лише `README.md` і `docs/ARCHITECTURE.md` (v1.5, червень 2026). Коду `src/`, `bin/` і `deploy/` немає, тому діаграми спираються тільки на ці два документи.

## Припущення

- Екран поштомата — окремий пристрій на боці поштомата, з якого мешканець вводить код. Він не частина контейнерів сервісу.
- Нічна задача `expire-parcels` — окремий контейнер. Документ не каже, чим її запускають, тому припускаю cron на VM, а не сервіс у compose. Це розходиться з розділом «Розгортання», де сервісів лише `api` і `worker`.
- Персонал працює через `GET /admin/parcels` якимось клієнтом. Який це клієнт, документ не уточнює, тому показую на діаграмі лише API.
- «Сесії персоналу» зберігаються в PostgreSQL, тобто автентифікація персоналу робиться в API.
- Система моніторингу — зовнішня, вона опитує `GET /health`.
- Назву SMS-провайдера і протокол, крім «HTTP API», документ не вказує.

## Рівень 1 — System Context

```mermaid
C4Context
    title Поштомат громади — System Context

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
    Person(courier, "Служба доставки", "Реєструє посилки сканером")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(parcel, "Поштомат громади", "Реєструє посилки, сповіщає мешканців, видає за кодом, повертає прострочені")

    System_Ext(locker, "Екран поштомата", "Пристрій, де мешканець вводить код")
    System_Ext(sms, "SMS-провайдер", "Надсилає SMS через HTTP API")
    System_Ext(monitor, "Моніторинг", "Опитує health-check")

    Rel(courier, parcel, "Реєструє посилку", "сканер, HTTP")
    Rel(resident, locker, "Вводить код")
    Rel(locker, parcel, "Передає код отримання", "HTTP")
    Rel(staff, parcel, "Дивиться список посилок", "HTTP")
    Rel(parcel, sms, "Просить надіслати SMS з кодом", "HTTPS")
    Rel(sms, resident, "Доставляє SMS з кодом")
    Rel(monitor, parcel, "Опитує GET /health", "HTTP")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Поштомат громади — Container diagram

    Person(resident, "Мешканець", "")
    Person(courier, "Служба доставки", "")
    Person(staff, "Персонал громади", "")
    System_Ext(locker, "Екран поштомата", "Вводить код отримання")
    System_Ext(sms, "SMS-провайдер", "HTTP API")
    System_Ext(monitor, "Моніторинг", "Опитує /health")

    System_Boundary(vm, "Одна VM") {
        Container_Boundary(compose, "docker compose (один образ)") {
            Container(api, "API", "Node.js, HTTP, src/server.js", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health")
            Container(worker, "Worker", "Node.js, src/worker.js", "Кожні 30 с бере посилки без сповіщення і шле SMS з 4-значним кодом")
        }
        Container(expire, "Нічна задача", "Node.js, bin/expire-parcels.js (cron — припущення)", "Позначає посилки старші за 72 год як повернені")
        ContainerDb(db, "PostgreSQL", "Поза контейнерами, на тій самій VM", "Посилки, події, сесії персоналу")
    }

    Rel(courier, api, "Реєструє посилку", "POST /parcels")
    Rel(locker, api, "Передає код", "POST /pickup")
    Rel(staff, api, "Список посилок", "GET /admin/parcels")
    Rel(monitor, api, "Health-check", "GET /health")
    Rel(api, db, "Читає і пише")
    Rel(worker, db, "Вибирає посилки без сповіщення, оновлює статус")
    Rel(expire, db, "Оновлює статус прострочених")
    Rel(worker, sms, "Надсилає SMS з кодом", "HTTPS")
    Rel(sms, resident, "SMS з кодом")
    Rel(resident, locker, "Вводить код")
```

Worker і API не викликають одне одного. Вони взаємодіють лише через PostgreSQL: API створює посилку, а worker бере ті, про які ще не сповіщено.

У `README.md` сказано, що в цьому репозиторії сховище лежить у пам'яті (`src/db.js`), а в продакшні той самий інтерфейс працює поверх PostgreSQL. Тому діаграма показує продакшн-схему.
