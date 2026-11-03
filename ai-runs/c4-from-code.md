Нижче — C4-діаграми для системи «Поштомат громади».

Явні припущення:

- PostgreSQL показано як зовнішню інфраструктурну систему/сховище, хоча в документації зазначено, що в поточній реалізації використовується in-memory store.
- Екран поштомата взаємодіє з API через HTTP.
- Служба доставки має сканер, який викликає API для реєстрації посилки.
- Нічна задача запускається cron на VM і використовує той самий контейнер/код доступу до даних.
- SMS-провайдер і кур’єрська система є зовнішніми системами.

## C4 — System Context

```mermaid
C4Context
    title System Context — «Поштомат громади»

    Person(citizen, "Мешканець", "Отримує SMS-код і забирає посилку з поштомата")
    Person(delivery, "Служба доставки", "Сканує та реєструє посилку в поштоматі")
    Person(staff, "Працівник громади", "Переглядає список посилок і їхній статус")

    System(poshtomat, "Система «Поштомат громади»", "Реєструє посилки, надсилає коди отримання, обробляє видачу та повернення посилок")

    System_Ext(locker, "Поштомат", "Екран/термінал, у якому мешканець вводить код отримання")
    System_Ext(sms, "SMS-провайдер", "Надсилає SMS на телефон мешканця")
    System_Ext(courier, "Система служби доставки", "Приймає запити на повернення неполучених посилок")

    Rel(delivery, poshtomat, "Реєструє посилку", "HTTPS/HTTP API")
    Rel(citizen, locker, "Вводить код отримання")
    Rel(locker, poshtomat, "Запитує видачу посилки", "HTTPS/HTTP API")
    Rel(poshtomat, sms, "Надсилає SMS з кодом", "HTTP API")
    Rel(staff, poshtomat, "Переглядає посилки", "HTTPS/HTTP API")
    Rel(poshtomat, courier, "Замовляє повернення посилки", "HTTP API")
```

## C4 — Container

```mermaid
C4Container
    title Container Diagram — «Поштомат громади»

    Person(citizen, "Мешканець", "Отримує SMS і забирає посилку")
    Person(delivery, "Служба доставки", "Реєструє посилку через сканер")
    Person(staff, "Працівник громади", "Переглядає адміністративний список")

    System_Ext(locker, "Поштомат", "Термінал для введення коду та видачі посилки")
    System_Ext(smsProvider, "SMS-провайдер", "HTTP API для надсилання SMS")
    System_Ext(courierSystem, "Система служби доставки", "HTTP API повернення посилок")
    System_Ext(cron, "Cron на VM", "Запускає нічну задачу повернення")

    System_Boundary(poshtomat, "Система «Поштомат громади»") {
        Container(api, "HTTP API", "Node.js HTTP server", "Реєстрація посилок, видача за кодом, адміністративний перегляд і health-check")
        Container(worker, "SMS Worker", "Node.js process", "Періодично знаходить ненотифіковані посилки та надсилає SMS-коди")
        Container(expirer, "Нічна задача повернення", "Node.js CLI / cron job", "Знаходить посилки старші за 72 години, позначає їх поверненими та передає запит кур’єру")
        ContainerDb(database, "PostgreSQL", "Реляційна база даних", "Посилки, події видачі та сесії персоналу")
    }

    Rel(delivery, api, "Реєструє посилку\nPOST /parcels", "HTTP/JSON")
    Rel(locker, api, "Видає посилку за кодом\nPOST /pickup", "HTTP/JSON")
    Rel(staff, api, "Переглядає посилки\nGET /admin/parcels", "HTTP/JSON")
    Rel(api, api, "Перевіряє стан\nGET /health", "HTTP")

    Rel(api, database, "Читає та змінює посилки,\nподії й сесії персоналу", "DB connection pool")
    Rel(worker, database, "Читає ненотифіковані посилки;\nоновлює notifiedAt", "DB connection pool")
    Rel(expirer, database, "Читає прострочені посилки;\nоновлює статус на returned", "DB connection pool")

    Rel(worker, smsProvider, "Надсилає SMS з кодом\nPOST /messages", "HTTP/JSON")
    Rel(expirer, courierSystem, "Замовляє повернення\nPOST /returns", "HTTP/JSON")
    Rel(cron, expirer, "Запускає щоночі", "Process execution")
```

### Основні потоки

```mermaid
flowchart LR
    D[Служба доставки] -->|POST /parcels| API[HTTP API]
    API --> DB[(PostgreSQL)]
    
    DB -->|Ненотифіковані посилки| W[SMS Worker]
    W -->|POST /messages| SMS[SMS-провайдер]
    SMS --> C[Мешканець]

    C -->|Вводить код| L[Поштомат]
    L -->|POST /pickup| API
    API -->|Позначає picked_up| DB

    CRON[Cron] --> E[Нічна задача]
    E -->|Посилки старші 72 годин| DB
    E -->|POST /returns| COURIER[Система доставки]
```