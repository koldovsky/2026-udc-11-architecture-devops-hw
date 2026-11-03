- Інструмент і модель: Claude Code 2.1.291 (CLI, `claude -p`, неінтерактивно), модель claude-opus-5-5
- Дата: 2026-11-03
- Що бачила сесія: тимчасова тека `../ws11-b-code/`: уся `app/`. Окрема нова сесія, запущена в цій теці; `--setting-sources project,local` — користувацькі налаштування й `~/.claude/CLAUDE.md` не підвантажувались; пам'ять між сесіями для цієї теки порожня (новий шлях проєкту). Дозволені інструменти: Read, Glob, Grep, Bash. Нижче — фінальна відповідь агента (журнал викликів інструментів не зберігався). Застереження: у батьківській теці `Documents/Git/` лежить чужий `AGENTS.md` (про інший проєкт) — Claude Code міг підвантажити його як контекст; паралельна сесія Task D прямо згадала його у відповіді як нерелевантний.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче дві C4-діаграми для «Поштомата громади» (`app/`, v1.7.3). Я будував їх за кодом у `src/` і `bin/`, бо `docs/ARCHITECTURE.md` застарів (див. розбіжності наприкінці).

## Рівень 1: System Context

```mermaid
C4Context
  title System Context: Поштомат громади

  Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з комірки")
  Person(staff, "Персонал громади", "Переглядає список посилок, бачить маскований номер і не бачить кодів")
  Person(courierOp, "Оператор служби доставки", "Кладе посилку в комірку і сканує її")

  System(poshtomat, "Поштомат громади", "Реєструє посилки, видає коди отримання, надсилає SMS, повертає посилки, які не забрали за 72 год")

  System_Ext(terminal, "Екран поштомата", "Термінал на самій шафі, приймає 6-значний код")
  System_Ext(scanner, "Сканер служби доставки", "Пристрій оператора")
  System_Ext(sms, "SMS-провайдер", "HTTP API для надсилання SMS")
  System_Ext(courierApi, "API повернень служби доставки", "Приймає заявки на повернення відправнику")
  System_Ext(monitoring, "Моніторинг", "Періодично перевіряє, чи сервіс живий")

  Rel(courierOp, scanner, "Сканує посилку")
  Rel(scanner, poshtomat, "Реєструє посилку", "HTTPS/JSON, POST /parcels")
  Rel(resident, terminal, "Вводить код")
  Rel(terminal, poshtomat, "Перевіряє код і відчиняє комірку", "HTTPS/JSON, POST /pickup")
  Rel(staff, poshtomat, "Переглядає посилки", "HTTPS/JSON + Bearer-сесія, GET /admin/parcels")
  Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTPS/JSON, Bearer-токен")
  Rel(sms, resident, "SMS: номер поштомата і код")
  Rel(poshtomat, courierApi, "Заявка на повернення після 72 год", "HTTPS/JSON, POST /returns")
  Rel(monitoring, poshtomat, "Перевірка стану", "HTTP, GET /health")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2: Container

```mermaid
C4Container
  title Container: Поштомат громади (одна VM)

  Person(resident, "Мешканець")
  Person(staff, "Персонал громади")
  System_Ext(scanner, "Сканер служби доставки")
  System_Ext(terminal, "Екран поштомата")
  System_Ext(monitoring, "Моніторинг")
  System_Ext(sms, "SMS-провайдер", "HTTP API")
  System_Ext(courierApi, "API повернень служби доставки", "HTTP API")

  System_Boundary(vm, "VM громади") {
    Container(api, "API", "Node.js 22, node:http, Docker-сервіс api", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Пул з'єднань до БД (DB_POOL_MAX), відповідає 503, коли пул переповнений")
    Container(worker, "SMS-воркер", "Node.js 22, Docker-сервіс worker, той самий образ", "Щоразу бере до 50 посилок без сповіщення. Якщо їх менше за 50, чекає 10 с. Обмежує темп SMS і повторює спробу при 429")
    Container(expire, "Нічна задача повернень", "Node.js 22 CLI, cron на VM", "Позначає посилки старші за 72 год як returned і створює заявку на повернення")
    ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза Docker", "Таблиці: посилки, події, сесії персоналу")
  }

  Rel(scanner, api, "Реєстрація посилки", "HTTPS/JSON")
  Rel(terminal, api, "Код отримання", "HTTPS/JSON")
  Rel(staff, api, "Список посилок", "HTTPS/JSON, Bearer")
  Rel(monitoring, api, "Health-check", "HTTP")

  Rel(api, db, "Посилки, події, пошук сесій", "SQL/TCP 5432")
  Rel(worker, db, "Читає посилки без сповіщення, ставить notifiedAt", "SQL/TCP 5432")
  Rel(expire, db, "Шукає прострочені, ставить returned", "SQL/TCP 5432")

  Rel(worker, sms, "POST /messages", "HTTPS/JSON, Bearer SMS_TOKEN")
  Rel(sms, resident, "SMS з кодом")
  Rel(expire, courierApi, "POST /returns", "HTTPS/JSON")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Припущення

1. **Межа системи.** Система — це бекенд з цього репозиторію. Екран поштомата і сканер я вважаю зовнішніми системами, бо їхнього коду тут немає.
2. **Служба доставки.** Я вважаю, що сканер і API повернень (`COURIER_BASE_URL`) належать одній службі доставки. На діаграмі вони окремі, бо це різні точки інтеграції.
3. **Як персонал заходить в адмінку.** У коді є лише `GET /admin/parcels` з Bearer-сесією, без жодного UI. Тому на діаграмі персонал звертається до API напряму, через невідомий клієнт.
4. **HTTPS.** Сервер слухає звичайний HTTP на порту 8080. Я вважаю, що TLS додає reverse proxy або балансувальник перед VM. Його немає ні в коді, ні в документації, тому на діаграмі його теж немає.
5. **Сховище.** У репозиторії воно лежить у пам'яті (`src/db.js`). На діаграмі PostgreSQL, бо README і ARCHITECTURE.md кажуть, що в продакшні той самий інтерфейс працює поверх PostgreSQL.
6. **Розгортання.** Те, що є одна VM з `docker compose` і сервісами `api` і `worker`, а PostgreSQL стоїть поза контейнерами, я взяв з ARCHITECTURE.md. Каталогу `deploy/` у робочій директорії немає, тож перевірити це я не зміг. Що нічну задачу запускає cron на VM, сказано в коментарі в `bin/expire-parcels.js`.
7. **Логи.** Логи пишуться в stdout у форматі JSON-lines. Куди вони йдуть далі, невідомо, тому окремої системи для них на діаграмі немає.

## Де `docs/ARCHITECTURE.md` (v1.5) розходиться з кодом (v1.7.3)

- **Інтервал воркера.** У документі 30 с. У коді `POLL_INTERVAL_MS = 10_000`, і якщо батч повний, наступний раунд починається одразу.
- **Довжина коду.** У документі 4 цифри, у коді 6 (`/^\d{6}$/`).
- **API повернень.** Нічна задача звертається до API повернень служби доставки, а в документі цієї інтеграції взагалі немає.
- **Обмеження SMS.** У документі не описано, що воркер обмежує темп SMS (`SMS_RATE_PER_SEC`) і повторює спробу з затримкою при 429.

Ще одна розбіжність: `AGENTS.md` пише про `src/money.ts`, але такого файлу в робочій директорії немає. Схоже, ця інструкція стосується іншого проєкту, тому на діаграмах я її не враховував.
