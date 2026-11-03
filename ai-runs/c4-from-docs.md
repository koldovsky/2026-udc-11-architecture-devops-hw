## Припущення

- «Ця система» — сервіс «Поштомат громади» з документації `README.md` та `ARCHITECTURE.md`.
- Екран поштомата та сканер служби доставки є зовнішніми клієнтами API.
- SMS-провайдер — зовнішня система.
- Нічна задача запускається планувальником на тій самій VM, але показана окремим контейнером/процесом.
- PostgreSQL у production працює поза Docker-контейнерами, на тій самій VM.

## C4: System Context

```mermaid
C4Context
    title System Context — «Поштомат громади»

    Person(courier, "Працівник служби доставки", "Реєструє посилки та передає їх до поштомата")
    Person(resident, "Мешканець громади", "Отримує SMS-код і забирає посилку")
    Person(staff, "Працівник/адміністратор", "Переглядає список посилок та їхні статуси")

    System(parcelSystem, "Поштомат громади", "Реєструє посилки, надсилає коди отримання та керує видачею посилок")

    System_Ext(deliveryScanner, "Сканер служби доставки", "Клієнт служби доставки для реєстрації посилки")
    System_Ext(lockerScreen, "Екран поштомата", "Інтерфейс введення коду та видачі посилки")
    System_Ext(smsProvider, "SMS-провайдер", "Надсилає SMS мешканцям")
    System_Ext(monitoring, "Система моніторингу", "Перевіряє доступність сервісу через health endpoint")

    Rel(courier, deliveryScanner, "Сканує посилку")
    Rel(deliveryScanner, parcelSystem, "Реєструє посилку", "HTTP/JSON")
    Rel(parcelSystem, smsProvider, "Передає SMS з кодом отримання", "HTTP API")
    Rel(smsProvider, resident, "Надсилає SMS з кодом")

    Rel(resident, lockerScreen, "Вводить код отримання")
    Rel(lockerScreen, parcelSystem, "Запитує видачу посилки", "HTTP/JSON")

    Rel(staff, parcelSystem, "Переглядає посилки", "HTTP/JSON")
    Rel(monitoring, parcelSystem, "Перевіряє стан сервісу", "GET /health")
```

## C4: Container

```mermaid
C4Container
    title Container Diagram — «Поштомат громади»

    Person(courier, "Працівник служби доставки", "Реєструє посилки")
    Person(resident, "Мешканець громади", "Забирає посилку за SMS-кодом")
    Person(staff, "Працівник/адміністратор", "Переглядає список посилок")

    System_Ext(deliveryScanner, "Сканер служби доставки", "Клієнт реєстрації посилок")
    System_Ext(lockerScreen, "Екран поштомата", "Клієнт видачі посилок")
    System_Ext(smsProvider, "SMS-провайдер", "Зовнішній сервіс надсилання SMS")
    System_Ext(monitoring, "Система моніторингу", "Перевіряє health endpoint")

    System_Boundary(parcelSystem, "Система «Поштомат громади»") {
        Container(api, "API", "Node.js HTTP service", "Реєстрація посилок, видача за кодом, адміністративний перегляд і health check")
        Container(worker, "SMS Worker", "Node.js worker", "Періодично знаходить посилки без сповіщення та надсилає SMS з 4-значним кодом")
        Container(expirer, "Нічна задача", "Node.js scheduled process", "Позначає посилки, що пролежали понад 72 години, як повернені")
        ContainerDb(database, "PostgreSQL", "PostgreSQL database", "Зберігає посилки, події та сесії персоналу")
    }

    Rel(courier, deliveryScanner, "Сканує посилку")
    Rel(deliveryScanner, api, "POST /parcels", "HTTP/JSON")

    Rel(resident, lockerScreen, "Вводить код")
    Rel(lockerScreen, api, "POST /pickup", "HTTP/JSON")

    Rel(staff, api, "Переглядає посилки", "GET /admin/parcels")
    Rel(monitoring, api, "Перевіряє доступність", "GET /health")

    Rel(api, database, "Читає та змінює дані", "SQL")
    Rel(worker, database, "Читає посилки та оновлює статуси", "SQL")
    Rel(expirer, database, "Знаходить прострочені посилки та оновлює статуси", "SQL")

    Rel(worker, smsProvider, "Надсилає SMS з кодом", "HTTP API")
```

### Розгортання

API, SMS Worker і нічна задача запускаються на одній VM через Docker Compose. PostgreSQL працює на цій самій VM поза контейнерами; конфігурація передається через змінні оточення.