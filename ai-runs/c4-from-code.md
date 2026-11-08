# C4-діаграми системи «Поштомат громади» (згенеровано з коду)

- Інструмент і модель: OpenCode (nemotron-3.5-super-vl-free)
- Дата: 2026-11-07
- Що бачила сесія: репозиторій `D:\Lessons_Selenium_Bionics\lesson1\ws11-b-code`, тека `app/` (вихідний код Node.js: `src/server.js`, `src/worker.js`, `src/db.js`, `src/parcels.js`, `src/sms.js`, `src/courier.js`, `src/config.js`, `bin/expire-parcels.js`, `docs/ARCHITECTURE.md`, `README.md`, `package.json` v1.7.3); тести не використовувалися для побудови архітектури.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  >    рівень System Context і рівень Container.
  >    Відповідь запиши в файл c4-from-code.md; інших файлів не створюй і уточнювальних питань не став —
  >    припущення називай явно

---

## Припущення (визначено явно)

1. **Межа системи** — сервіс «Поштомат громади» (код у `app/`), версія 1.7.3: HTTP API, робочий процес SMS-сповіщень, нічна задача прострочення посилок і база даних.
2. **Екран поштомата (термінал видачі)** — пристрій кур'єрської/поштової інфраструктури, зовнішній для системи; мешканець вводить на ньому код отримання, а термінал надсилає `POST /pickup` до API.
3. **Розгортання** — одна VM, docker compose з двома сервісами (`api`, `worker`) з одного образу (за `docs/ARCHITECTURE.md`). Нічне завдання `bin/expire-parcels.js` модельюю як окремий контейнер/запуск через cron на цій же VM (у репозиторії теки `deploy/` не знайдено).
4. **База даних** — у продакшені PostgreSQL на тій самій VM, поза контейнерами; локально і в тестах той самий інтерфейс працює над in-memory store (`src/db.js`). На діаграмах показано PostgreSQL.
5. **Зовнішні системи** — SMS-провайдер (`POST /messages`, повтори при 429) і API кур'єрської компанії (`POST /returns`).
6. **Інтервал опроса Worker** — 10 с (`POLL_INTERVAL_MS = 10_000` у коді); у `README.md` написано 30 с — відхилення позначено, на діаграмі використано значення з коду.
7. Тіку поштомата працює з `TZ=Europe/Kyiv` (з `src/log.js`), це не впливає на C4-діаграми.

---

## 1. System Context (C4)

```mermaid
C4Context
    title Системний контекст «Поштомат громади» (v1.7.3)

    Person(resident, "Мешканець", "Отримує SMS з кодом і вводить його на екрані поштомата, щоб забрати посилку")
    Person(courier, "Служба доставки (кур'єр зі сканером)", "Кладе посилку в комірку поштомата і реєструє її")
    Person(staff, "Персонал поштомата / адміністратор", "Переглядає список посилок (телефони маскировані, коди приховані)")
    Person(monitoring, "Моніторинг", "Опитує ендпоінт GET /health")

    System(sys, "Поштомат громади", "Сервіс посилочних поштоматів громади: реєстрація посилок, SMS-сповіщення, видача по коду, прострочення неотриманих посилок")

    System_Ext(lockerScreen, "Екран поштомата (термінал видачі)", "Пристрій введення коду отримання (зовнішній для системи)")
    System_Ext(sms, "SMS-провайдер", "Надсилає SMS з кодом отримання (HTTP API)")
    System_Ext(courierApi, "API кур'єрської компанії", "Приймає заявки на повернення посилок (HTTP API)")

    Rel(resident, lockerScreen, "Вводить код отримання")
    Rel(lockerScreen, sys, "POST /pickup — перевірка коду", "HTTP/JSON")
    Rel(sys, resident, "SMS з кодом отримання", "SMS (через SMS-провайдера)")
    Rel(courier, sys, "POST /parcels — реєстрація посилки (сканер)", "HTTP/JSON")
    Rel(staff, sys, "GET /admin/parcels — список посилок (Bearer-сесія)", "HTTP/JSON")
    Rel(monitoring, sys, "GET /health — перевірка стану", "HTTP/JSON")
    Rel(sys, sms, "Сповіщення про прибуття посилки", "HTTP/JSON")
    Rel(sys, courierApi, "Заявка на повернення неотриманої посилки", "HTTP/JSON")

    UpdateLayout()
```

---

## 2. Container (C4)

```mermaid
C4Container
    title Контейнери «Поштомата громади» (v1.7.3)

    Person(resident, "Мешканець", "Отримує SMS з кодом і вводить його на екрані поштомата")
    Person(courier, "Служба доставки (кур'єр зі сканером)", "Реєструє посилку, кладучи її в комірку")
    Person(staff, "Персонал поштомата / адміністратор", "Переглядає список посилок через адмін-API")
    Person(monitoring, "Моніторинг", "Опитує GET /health")

    System_Ext(sms, "SMS-провайдер", "HTTP API POST /messages (з повторами при 429)")
    System_Ext(courierApi, "API кур'єрської компанії", "HTTP API POST /returns")
    System_Ext(lockerScreen, "Екран поштомата (термінал)", "Пристрій введення коду отримання")

    Container_Boundary(env, "Окруження: одна VM, docker compose (сервіси api і worker з одного образу)") {
        Container(api, "API", "Node.js, src/server.js", "HTTP API на порту 8080: POST /parcels, POST /pickup, GET /admin/parcels, GET /health; пул з'єднань до БД")
        Container(worker, "Worker", "Node.js, src/worker.js", "Опрос несповіщених посилок кожні 10 с (пакети по 50) і надсилання SMS")
        Container(expire, "Задача прострочення посилок", "Node.js, bin/expire-parcels.js", "Нічне завдання cron на VM: посилки старіше 72 год → статус «повернено» + заявка кур'єру")
        Container(db, "База даних", "PostgreSQL (т. ж. VM, поза контейнерами)", "Посилки, події, сесії персоналу; локально/тести — in-memory store (src/db.js)")
    }

    Rel(resident, lockerScreen, "Вводить код отримання")
    Rel(lockerScreen, api, "POST /pickup", "HTTP/JSON")
    Rel(courier, api, "POST /parcels (сканер)", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels (Bearer-сесія)", "HTTP/JSON")
    Rel(monitoring, api, "GET /health", "HTTP/JSON")
    Rel(api, db, "Читання/запис посилок, подій, сесій", "TCP 5432 (пул, max 4)")
    Rel(worker, db, "Несповіщені посилки, оновлення notifiedAt", "TCP 5432 (пул)")
    Rel(worker, sms, "SMS про прибуття посилки", "HTTP/JSON")
    Rel(expire, db, "Пошук прострочених, оновлення статусу", "TCP 5432")
    Rel(expire, courierApi, "Заявка на повернення (not_picked_up_72h)", "HTTP/JSON")

    UpdateLayout()
```

---

### Короткий ключ елементів

| Елемент | Що це |
|---|---|
| **API** (`api`) | Node.js HTTP-сервер (`src/server.js`, порт 8080). Реєстрація посилок сканером, видача по коду, адмін-список, health-check. |
| **Worker** (`worker`) | Node.js-процес (`src/worker.js`). кожні 10 с бере пачку несповіщених посилок і шле SMS через SMS-провайдера. |
| **Задача прострочення** (`expire`) | Node.js-скрипт (`bin/expire-parcels.js`), нічний cron на VM: посилки > 72 год → повернені, заявка кур'єру. |
| **База даних** (`db`) | PostgreSQL на тій самій VM поза контейнерами (посилки, події, сесії). Локально — in-memory store. |
| **SMS-провайдер / API кур'єра** | Зовнішні HTTP-системи, не належать до «Поштомата громади». |
