- Інструмент і модель: Claude Code (Workflow-субагент general-purpose), Claude Fable 5 (`claude-fable-5`)
- Дата: 2026-11-03
- Що бачила сесія: тимчасова тека ../ws11-b-code — уся `app/`. Прогін запускався субагентом із сесії в корені репо, тому субагенту системно підвантажувався `CLAUDE.md` репо (він посилається на `AGENTS.md`); агенту явно вказано читати лише тимчасову теку. Пам'ять між сесіями в субагентів відсутня; відповідь нижче — перша, дослівно.
- Промпт (дослівно):

  > Твоя робоча тека: C:/Users/777ma/IdeaProjects/ws11-b-code — це корінь проєкту. Читай лише файли в цій теці й не зазирай в інші теки.
  >
  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Я прочитав усі файли в `C:/Users/777ma/IdeaProjects/ws11-b-code` (README, `docs/ARCHITECTURE.md`, `package.json`, `src/*`, `bin/expire-parcels.js`, тести). Нижче — C4-діаграми системи «Поштомат громади».

## Рівень 1 — System Context

```mermaid
C4Context
    title Поштомат громади — System Context (C4, рівень 1)

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку на поштоматі")
    Person(courierOp, "Оператор служби доставки", "Сканером реєструє посилку, покладену в комірку")
    Person(staff, "Персонал громади", "Переглядає список посилок (ролі staff/admin)")

    System(poshtomat, "Поштомат громади", "Реєстрація посилок, SMS-сповіщення з 6-значним кодом, видача за кодом, повернення після 72 годин")

    System_Ext(lockerTerminal, "Термінал поштомата", "Екран поштомата: приймає код від мешканця, відкриває комірку")
    System_Ext(smsProvider, "SMS-провайдер", "Зовнішній HTTP API надсилання SMS")
    System_Ext(courierApi, "API кур'єрської компанії", "Приймає заявки на повернення посилок відправнику")
    System_Ext(monitoring, "Моніторинг", "Опитує стан сервісу")

    Rel(courierOp, poshtomat, "Реєструє посилку", "HTTPS: POST /parcels")
    Rel(resident, lockerTerminal, "Вводить код отримання")
    Rel(lockerTerminal, poshtomat, "Перевіряє код, фіксує видачу", "HTTPS: POST /pickup")
    Rel(staff, poshtomat, "Дивиться список посилок", "HTTPS: GET /admin/parcels, Bearer-сесія")
    Rel(poshtomat, smsProvider, "Шле SMS з кодом отримання", "HTTPS: POST /messages")
    Rel(smsProvider, resident, "SMS: «Посилка чекає, код …»")
    Rel(poshtomat, courierApi, "Заявка на повернення (не забрано за 72 год)", "HTTPS: POST /returns")
    Rel(monitoring, poshtomat, "Health-check", "HTTPS: GET /health")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Поштомат громади — Container (C4, рівень 2)

    Person(courierOp, "Оператор служби доставки")
    Person(resident, "Мешканець")
    Person(staff, "Персонал громади")

    System_Boundary(vm, "Одна VM (docker compose, api та worker з одного образу)") {
        Container(api, "API", "Node.js >=22, вбудований node:http (src/server.js)", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Валідація, генерація 6-значних кодів, маскування телефонів, сесійна авторизація персоналу, пул з'єднань до БД")
        Container(worker, "Worker сповіщень", "Node.js, той самий образ (src/worker.js)", "Цикл кожні 10 с: бере до 50 несповіщених посилок і шле SMS з кодом; rate limiting і retry з backoff при 429")
        Container(expireJob, "Нічна задача expire-parcels", "Node.js, cron на VM (bin/expire-parcels.js)", "Посилки, що пролежали понад 72 год, позначає returned і створює заявку на повернення в кур'єрському API")
        ContainerDb(db, "PostgreSQL", "На тій самій VM, поза контейнерами", "Таблиці: посилки, події, сесії персоналу")
    }

    System_Ext(lockerTerminal, "Термінал поштомата", "Екран поштомата")
    System_Ext(smsProvider, "SMS-провайдер", "HTTP API: POST /messages")
    System_Ext(courierApi, "API кур'єрської компанії", "HTTP API: POST /returns")
    System_Ext(monitoring, "Моніторинг")

    Rel(courierOp, api, "Реєструє посилку", "HTTPS/JSON: POST /parcels")
    Rel(resident, lockerTerminal, "Вводить код")
    Rel(lockerTerminal, api, "Перевірка коду, видача", "HTTPS/JSON: POST /pickup")
    Rel(staff, api, "Список посилок (без кодів, телефони замасковано)", "HTTPS: GET /admin/parcels, Bearer")
    Rel(monitoring, api, "Health-check", "HTTPS: GET /health")

    Rel(api, db, "Читає/пише посилки, події; шукає сесії", "SQL через пул з'єднань")
    Rel(worker, db, "listUnnotified, updateParcel(notifiedAt)", "SQL через пул")
    Rel(worker, smsProvider, "Надсилає SMS", "HTTPS/JSON, Bearer-токен, ≤5 req/s")
    Rel(smsProvider, resident, "SMS з кодом отримання")
    Rel(expireJob, db, "findExpired, markReturned", "SQL через пул")
    Rel(expireJob, courierApi, "Заявка на повернення", "HTTPS/JSON: POST /returns, reason=not_picked_up_72h")
```

## Явні припущення

1. **Термінал поштомата та сканер кур'єра — зовнішні клієнти.** Їхнього коду в репозиторії немає; вони лише викликають HTTP API (`POST /pickup`, `POST /parcels`), тому змодельовані як зовнішня система і актор відповідно.
2. **Сховище в продакшні — PostgreSQL.** У репозиторії `src/db.js` — in-memory store; README і ARCHITECTURE.md прямо кажуть, що в продакшні той самий інтерфейс працює поверх PostgreSQL на тій самій VM поза контейнерами. На діаграмі показано продакшн-варіант.
3. **Розбіжності коду з ARCHITECTURE.md вирішено на користь коду** (документ v1.5, код v1.7.3): інтервал опитування worker — 10 с (`POLL_INTERVAL_MS = 10_000`), а не 30 с; код отримання — 6-значний (`parcels.js`), а не 4-значний.
4. **Розгортання:** одна VM, `docker compose` з сервісами `api` і `worker` з одного образу — за ARCHITECTURE.md; згаданої там теки `deploy/` у робочій директорії немає, тому деталі compose-файлу не відомі. Нічна задача — cron на VM (коментар у `bin/expire-parcels.js`).
5. **Моніторинг** показано як зовнішню систему, бо ARCHITECTURE.md каже «моніторинг опитує `GET /health`», але сам інструмент моніторингу в репозиторії не визначено.
6. **Протокол** позначено HTTPS для зовнішніх взаємодій як типове припущення для продакшну; у коді це plain HTTP (`node:http`, `fetch` на `baseUrl` зі змінних оточення), тож TLS, імовірно, термінується поза застосунком.
7. Worker оновлює `notifiedAt` лише після успішного надсилання SMS; невдалі спроби лишаються в черзі на наступний цикл — це відображено як єдиний зв'язок worker—БД, без окремої черги повідомлень (черги в системі немає, координація — через стан у БД).
