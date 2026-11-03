- Інструмент і модель: Claude Code 2.1.317 (`claude -p`, неінтерактивна сесія), Claude Opus 5.5 (`claude-opus-5-5`)
- Дата: 2026-11-04
- Що бачила сесія: тимчасова тека `../ws11-b-code/` з копією всієї `app/`. Нова сесія без історії; глобального `~/.claude/CLAUDE.md` немає, пам'ять для нової теки порожня. Дозволено лише читання (Read/Grep/Glob, ls/cat/grep/find); файлів сесія не створювала.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче дві C4-діаграми в Mermaid. Вони зібрані з коду в `app/` (версія 1.7.3). `docs/ARCHITECTURE.md` датований v1.5 і в кількох місцях уже не збігається з кодом. Де вони розходяться, я брав код; розбіжності перелічені наприкінці.

## Рівень 1 — System Context

```mermaid
C4Context
  title Поштомат громади — System Context

  Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з комірки")
  Person(courier, "Кур'єр служби доставки", "Кладе посилку в комірку і сканує її")
  Person(staff, "Персонал громади", "Дивиться список посилок (staff / admin)")

  System(poshtomat, "Поштомат громади", "Бекенд: реєстрація посилок, коди отримання, SMS-сповіщення, повернення через 72 год")

  System_Ext(terminal, "Термінал поштомата", "Екран, на якому вводять код; відчиняє комірку")
  System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку при закладанні")
  System_Ext(sms, "SMS-провайдер", "HTTP API для надсилання SMS")
  System_Ext(courierApi, "API повернень служби доставки", "Приймає заявки на забір посилки назад відправнику")
  System_Ext(monitoring, "Моніторинг", "Опитує health-check")

  Rel(courier, scanner, "Сканує посилку")
  Rel(scanner, poshtomat, "Реєструє посилку", "HTTPS/JSON")
  Rel(resident, terminal, "Вводить 6-значний код")
  Rel(terminal, poshtomat, "Перевіряє код", "HTTPS/JSON")
  Rel(staff, poshtomat, "Переглядає посилки (телефони замасковано)", "HTTPS/JSON, Bearer")
  Rel(monitoring, poshtomat, "GET /health", "HTTP")
  Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTPS/JSON")
  Rel(sms, resident, "SMS: номер поштомата і код")
  Rel(poshtomat, courierApi, "Заявка на повернення (не забрано 72 год)", "HTTPS/JSON")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2 — Container

```mermaid
C4Container
  title Поштомат громади — Container

  Person(resident, "Мешканець")
  Person(staff, "Персонал громади")

  System_Ext(terminal, "Термінал поштомата")
  System_Ext(scanner, "Сканер служби доставки")
  System_Ext(monitoring, "Моніторинг")
  System_Ext(sms, "SMS-провайдер", "HTTP API, POST /messages")
  System_Ext(courierApi, "API повернень служби доставки", "HTTP API, POST /returns")

  System_Boundary(sys, "Поштомат громади — одна VM, docker compose") {
    Container(api, "API", "Node.js 22, node:http", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Пул БД: 4 з'єднання, очікування 2 с, далі 503")
    Container(worker, "SMS worker", "Node.js 22", "Цикл: кожні 10 с бере до 50 посилок без сповіщення; якщо пачка повна, бере наступну одразу")
    Container(expire, "Нічна задача expire-parcels", "Node.js 22, cron на VM", "Шукає посилки waiting понад 72 год, ставить їм returned і просить кур'єра забрати")
    ContainerDb(db, "PostgreSQL", "PostgreSQL, на VM поза контейнерами", "Таблиці: parcels, events, sessions")
  }

  Rel(scanner, api, "POST /parcels", "JSON/HTTP")
  Rel(terminal, api, "POST /pickup {code}", "JSON/HTTP")
  Rel(staff, api, "GET /admin/parcels", "JSON/HTTP, Bearer session")
  Rel(monitoring, api, "GET /health", "HTTP")

  Rel(api, db, "Пише посилки й події, читає сесії", "SQL, пул")
  Rel(worker, db, "Читає посилки без сповіщення, ставить notifiedAt", "SQL, пул")
  Rel(expire, db, "Читає прострочені, ставить returned", "SQL, пул")

  Rel(worker, sms, "Надсилає SMS: до 5/с, повтор на 429 (до 4 спроб)", "HTTPS/JSON, Bearer SMS_TOKEN")
  Rel(sms, resident, "SMS з кодом")
  Rel(expire, courierApi, "Заявка на повернення, reason not_picked_up_72h", "HTTPS/JSON")

  UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")
```

## Припущення

1. **Термінал і сканер — зовнішні системи.** Їхнього коду в репозиторії немає, є тільки виклики `POST /pickup` і `POST /parcels`. Тому на діаграмах вони лежать за межами системи.
2. **Хто реєструє посилки і хто їх забирає назад — одна служба доставки.** Сканер (`POST /parcels`) і API повернень (`src/courier.js`) я віднес до однієї організації. У коді це прямо не сказано.
3. **Клієнта для персоналу немає.** Показано тільки виклик `GET /admin/parcels` з `Bearer`-сесією, яку API перевіряє в таблиці sessions. Ендпоінту логіну немає, тож хто і як створює сесії, невідомо.
4**Логів на діаграмах немає.** Усі процеси пишуть JSON-рядки в stdout. Куди логи потрапляють далі, невідомо.

## Де `docs/ARCHITECTURE.md` (v1.5) розходиться з кодом (1.7.3)

| Документ | Код |
|---|---|
| Worker опитує кожні 30 с | `POLL_INTERVAL_MS = 10_000`; якщо пачка з 50 повна, наступна береться одразу |
| Код отримання 4-значний | 6-значний (`parcels.js`, `/^\d{6}$/`) |
| Нічна задача тільки позначає посилки поверненими | Вона ще й викликає API повернень служби доставки (`POST /returns`) — у документі такої зовнішньої системи немає |
| Обмеження SMS не описані | До 5 SMS/с (`SMS_RATE_PER_SEC`), експоненційні повтори на 429 |

## Що варто перевірити

Це помітив, поки читав `bin/expire-parcels.js` і `src/courier.js`:

- **Посилка може «повернутися» без заявки кур'єру.** Нічна задача спершу ставить посилці `returned`, а вже потім викликає кур'єра. Якщо API кур'єра відповість помилкою, посилка лишиться позначеною як повернена, а заявку не буде створено. Решта посилок у тому прогоні теж не обробиться: помилку ніде не перехоплюють.
- **Запит до API кур'єра без автентифікації.** Він іде без жодного токена, і в конфігурації його теж немає.
