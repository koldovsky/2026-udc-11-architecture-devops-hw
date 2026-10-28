- Інструмент і модель: Claude Code (VS Code), claude-opus-5-5, effort Medium
- Дата: 2026-10-25
- Що бачила сесія: тимчасова тека `../ws11-b-docs` — лише `app/README.md` і `app/docs/ARCHITECTURE.md` (без коду, `.git`, `AGENTS.md`, `CLAUDE.md`); нова сесія, пам'ять і глобальні інструкції відсутні
- Промпт (дослівно):

```text
Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
рівень System Context і рівень Container.
Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
припущення називай явно.
```

---

Діаграми побудовані лише з документації. У робочій теці є тільки два файли: app/README.md і app/docs/ARCHITECTURE.md. Тек src/ і deploy/, на які вони посилаються, немає, тож звірити схему з кодом я не зміг.

Рівень 1. System Context

```mermaid
C4Context
    title Поштомат громади. System Context

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку")
    Person(courier, "Кур'єр служби доставки", "Реєструє посилку сканером")
    Person(staff, "Персонал громади", "Переглядає список посилок")

    System(post, "Поштомат громади", "Реєструє посилки, сповіщає мешканців, видає посилки за кодом, повертає прострочені")

    System_Ext(kiosk, "Термінал поштомата", "Екран для введення коду і замки комірок")
    System_Ext(scanner, "Сканер служби доставки", "Пристрій або застосунок кур'єра")
    System_Ext(sms, "SMS-провайдер", "Зовнішній HTTP API для розсилки SMS")
    System_Ext(monitoring, "Моніторинг", "Перевіряє, чи сервіс живий")

    Rel(courier, scanner, "Сканує посилку")
    Rel(scanner, post, "Реєструє посилку", "HTTPS, POST /parcels")
    Rel(resident, kiosk, "Вводить 4-значний код")
    Rel(kiosk, post, "Перевіряє код", "HTTPS, POST /pickup")
    Rel(staff, post, "Переглядає посилки", "HTTPS, GET /admin/parcels")
    Rel(post, sms, "Надсилає SMS з кодом", "HTTPS")
    Rel(sms, resident, "Доставляє SMS", "GSM")
    Rel(monitoring, post, "Опитує стан", "HTTP, GET /health")

    UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")
```

Рівень 2. Container

```mermaid
C4Container
    title Поштомат громади. Container

    Person(resident, "Мешканець")
    Person(staff, "Персонал громади")
    System_Ext(scanner, "Сканер служби доставки")
    System_Ext(kiosk, "Термінал поштомата")
    System_Ext(monitoring, "Моніторинг")
    System_Ext(sms, "SMS-провайдер", "HTTP API")

    System_Boundary(post, "Поштомат громади. Одна VM") {
        Container(api, "API", "Node.js 22, HTTP, Docker-сервіс api", "Реєстрація посилок, перевірка коду, адмінський список, health-check")
        Container(worker, "Worker", "Node.js 22, Docker-сервіс worker, той самий образ", "Кожні 30 с шукає посилки без сповіщення і шле SMS")
        Container(expire, "Нічна задача", "Node.js-скрипт, запуск за розкладом", "Позначає посилки старші за 72 год як повернені")
        ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза Docker", "Таблиці: посилки, події, сесії персоналу")
    }

    Rel(scanner, api, "POST /parcels", "HTTPS, JSON")
    Rel(kiosk, api, "POST /pickup", "HTTPS, JSON")
    Rel(staff, api, "GET /admin/parcels", "HTTPS, браузер")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає і пише посилки, події, сесії", "SQL")
    Rel(worker, db, "Вибирає несповіщені посилки, позначає сповіщення", "SQL")
    Rel(expire, db, "Оновлює статус на повернено", "SQL")
    Rel(worker, sms, "Надсилає SMS з кодом", "HTTPS")
    Rel(sms, resident, "SMS з кодом", "GSM")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

Припущення
Термінал і сканер зовнішні. Їхнього коду в репозиторії немає, тому вони стоять поза межею системи. Якщо екран поштомата розробляє та сама команда, його треба перенести всередину межі як окремий контейнер.
Комірку відчиняє термінал. API лише перевіряє код і відповідає, а замком керує термінал.
Код генерує API. Код отримання створюється і зберігається під час реєстрації посилки, а worker лише читає його з бази. Документація каже тільки, що worker шле SMS з кодом.
Телефон мешканця передає сканер. Інакше незрозуміло, звідки worker бере номер.
Worker і нічна задача працюють з базою напряму. Вони не ходять через API.
Нічну задачу запускає cron на VM. Імовірно, через одноразовий запуск того самого образу. У Docker Compose її серед сервісів немає, а розклад ніде не описано.
Персонал автентифікується. На це вказує таблиця сесій персоналу. Проте ендпоінта входу серед задокументованих немає, тож або документація неповна, або сесії створюються інакше.
Зовнішній трафік іде через HTTPS. Документація згадує лише HTTP, тож TLS, імовірно, термінується перед API.
Локальне сховище не показане. У репозиторії воно в пам'яті, а на діаграмах зображено продакшн-варіант з PostgreSQL.
