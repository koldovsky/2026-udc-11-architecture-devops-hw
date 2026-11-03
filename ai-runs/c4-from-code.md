- Інструмент і модель: Claude Code, Claude Opus 5.5
- Дата: 2026-11-03
- Що бачила сесія: тимчасова тека ../ws11-b-code, у ній уся app/
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче обидві діаграми для системи «Поштомат громади» (`poshtomat` 1.7.3). Я зібрав їх із коду в `app/`, а `docs/ARCHITECTURE.md` застарів (v1.5), тому там, де вони розходяться, спирався на код. Обидві рендеряться без помилок у mermaid-cli. Єдина відома вада — лінія `POST /returns` зачіпає кут блока Worker. C4 у Mermaid експериментальний, тому в іншій версії компонування може трохи зсунутися.

## Рівень 1: System Context

```mermaid
%%{init: {"c4": {"width": 175, "c4ShapeMargin": 30, "diagramMarginX": 10}}}%%
C4Context
  title Поштомат громади — System Context

  System_Ext(sms, "SMS-провайдер", "Доставляє SMS")
  Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
  Person(carrier, "Кур'єр служби доставки", "Кладе посилку в комірку і сканує її")

  Person(staff, "Персонал", "Переглядає список посилок")
  System_Ext(terminal, "Екран поштомата", "Приймає код від мешканця")
  System_Ext(scanner, "Сканер служби доставки", "Передає дані посилки")

  System_Ext(monitoring, "Моніторинг", "Перевіряє доступність")
  System(poshtomat, "Поштомат громади", "Реєструє посилки, сповіщає про прибуття, видає за кодом, повертає незабрані")
  System_Ext(returns, "API повернень кур'єрської компанії", "Забирає посилку і везе відправнику")

  Rel(sms, resident, "Доставляє код", "SMS")
  Rel(resident, terminal, "Вводить код")
  Rel(carrier, scanner, "Сканує посилку")
  Rel(terminal, poshtomat, "Перевіряє код", "JSON/HTTP")
  Rel(scanner, poshtomat, "Реєструє посилку", "JSON/HTTP")
  Rel(staff, poshtomat, "Дивиться посилки", "JSON/HTTP, Bearer")
  Rel(monitoring, poshtomat, "Опитує стан", "HTTP")
  Rel(poshtomat, sms, "Надсилає текст із кодом", "JSON/HTTP, Bearer")
  Rel(poshtomat, returns, "Замовляє повернення", "JSON/HTTP")

  UpdateRelStyle(sms, resident, $offsetX="-30", $offsetY="-50")
  UpdateRelStyle(poshtomat, sms, $offsetX="-90", $offsetY="-110")
  UpdateRelStyle(monitoring, poshtomat, $offsetX="-75", $offsetY="50")
  UpdateRelStyle(poshtomat, returns, $offsetX="75", $offsetY="78")
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2: Container

```mermaid
%%{init: {"c4": {"width": 175, "c4ShapeMargin": 30, "diagramMarginX": 10}}}%%
C4Container
  title Поштомат громади — Container

  Person(staff, "Персонал", "Переглядає список посилок")
  System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку")
  System_Ext(terminal, "Екран поштомата", "Надсилає введений код")
  System_Ext(monitoring, "Моніторинг", "Перевіряє доступність")

  System_Boundary(poshtomat, "Поштомат громади") {
    Container(job, "Нічна задача", "Node.js 22+, cron на VM", "Повертає посилки, що лежать понад 72 год")
    ContainerDb(db, "База даних", "PostgreSQL на тій самій VM", "Посилки, події, сесії персоналу")
    Container(api, "API", "Node.js 22+, node:http", "Реєстрація, видача за кодом, список для персоналу, стан сервісу")
    Container(worker, "Worker", "Node.js 22+", "Опитує БД кожні 10 с, шле SMS з кодом, партія до 50")
  }

  Boundary(ext, "Вихідні інтеграції", "external") {
    System_Ext(sms, "SMS-провайдер", "Доставляє SMS мешканцю")
    System_Ext(returns, "API повернень кур'єрської компанії", "Забирає посилку і везе відправнику")
  }

  Rel(staff, api, "GET /admin/parcels", "JSON/HTTP, Bearer")
  Rel(scanner, api, "POST /parcels", "JSON/HTTP")
  Rel(terminal, api, "POST /pickup", "JSON/HTTP")
  Rel(monitoring, api, "GET /health", "HTTP")
  Rel(api, db, "Посилки, події, сесії", "SQL")
  Rel(worker, db, "Несповіщені, notifiedAt", "SQL")
  Rel(job, db, "Прострочені, returned", "SQL")
  Rel(worker, sms, "POST /messages", "JSON/HTTP, Bearer")
  Rel(job, returns, "POST /returns", "JSON/HTTP")

  UpdateRelStyle(monitoring, api, $offsetX="-120", $offsetY="-45")
  UpdateRelStyle(job, db, $offsetX="-118", $offsetY="-95")
  UpdateRelStyle(api, db, $offsetX="0", $offsetY="85")
  UpdateRelStyle(worker, db, $offsetX="70", $offsetY="45")
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Припущення

1. **PostgreSQL і SQL:** у цій копії коду PostgreSQL немає. [db.js](app/src/db.js) зберігає дані в пам'яті, а `dbUrl` із конфігурації ніде не використовується. Базу я намалював за README та ARCHITECTURE.md.
2. **VM і cron:** теки `deploy/`, на яку посилається документація, тут немає, тому розгортання на одній VM я не перевіряв. Коментар у [expire-parcels.js](app/bin/expire-parcels.js) каже лише про cron на VM, а як саме він запускає задачу, невідомо. Тому задача показана окремим контейнером.
3. **Екран поштомата і сканер:** вони зовнішні, бо їхнього коду тут немає. Якщо це ваша розробка, перенесіть їх у межі системи.
4. **Кур'єр і кур'єрська компанія:** роль кур'єра зі сканером я вивів сам: у коді є лише сканер оператора доставки. Служба доставки та кур'єрська компанія можуть бути однією організацією; API повернень показаний окремо, бо це інша інтеграція.
5. **Персонал:** він звертається до API напряму, бо адмінінтерфейсу в репозиторії немає.
6. **Моніторинг:** конкретний продукт невідомий. У коді є лише `GET /health`, а про опитування моніторингом сказано в документації.
7. **HTTP:** TLS або проксі перед API в коді не видно, тому підписано просто HTTP.

## Де код розходиться з документацією

| Що | ARCHITECTURE.md | Код |
|---|---|---|
| Інтервал Worker | 30 с | 10 с, а після повної партії з 50 SMS наступний прохід одразу ([worker.js](app/src/worker.js#L8-L9)) |
| Код отримання | 4 цифри | 6 цифр ([parcels.js](app/src/parcels.js#L27)) |
| Нічна задача | лише позначає посилки поверненими | ще й викликає `POST /returns` у кур'єрської компанії ([courier.js](app/src/courier.js)) |

## Чого в цьому коді немає

- **Автентифікація:** `POST /parcels` і `POST /pickup` її не мають, а клієнт API повернень не надсилає токена. Захист може бути на мережевому рівні, але тут його не видно.
- **Вхід персоналу:** ендпоінта входу немає. Сесії лише шукаються в базі, а хто їх створює, з коду незрозуміло.
- **Відкриття комірки:** `/pickup` повертає лише `id` і `lockerId`, тому на діаграмах цього кроку немає.

Для перевірки рендера я тимчасово поставив mermaid-cli у тимчасову теку сесії; у проєкті нічого не змінено.