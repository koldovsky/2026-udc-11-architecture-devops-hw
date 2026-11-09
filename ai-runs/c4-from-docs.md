- Інструмент і модель: Codex subagent, GPT-6
- Дата: 2026-11-09
- Що бачила сесія: `../ws11-b-docs/` — лише `app/README.md` і `app/docs/` (без історії попередніх прогонів)
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче межа системи означає **серверну частину «Поштомата громади»**. Екран поштомата, сканер служби доставки, SMS-провайдер і моніторинг показані як зовнішні системи.

### System Context

```mermaid
C4Context
    title Поштомат громади — System Context

    Person(resident, "Мешканець", "Забирає посилку за кодом")
    Person(courier, "Служба доставки", "Реєструє посилки")
    Person(staff, "Персонал", "Переглядає список посилок")

    System(parcel, "Поштомат громади", "Реєстрація, видача, сповіщення та облік посилок")

    System_Ext(screen, "Екран поштомата", "Приймає код від мешканця")
    System_Ext(scanner, "Сканер служби доставки", "Передає дані посилки")
    System_Ext(sms, "SMS-провайдер", "Доставляє сповіщення")
    System_Ext(monitoring, "Моніторинг", "Перевіряє доступність сервісу")

    Rel(resident, screen, "Вводить код отримання")
    Rel(screen, parcel, "Надсилає код для видачі", "HTTP")
    Rel(courier, scanner, "Сканує посилку")
    Rel(scanner, parcel, "Реєструє посилку", "HTTP")
    Rel(staff, parcel, "Отримує список посилок", "HTTP")
    Rel(monitoring, parcel, "Перевіряє стан", "HTTP")
    Rel(parcel, sms, "Надсилає SMS з кодом", "HTTP")
    Rel(sms, resident, "Доставляє SMS")
```

### Container

```mermaid
C4Container
    title Поштомат громади — Container

    Person(resident, "Мешканець")
    Person(courier, "Служба доставки")
    Person(staff, "Персонал")

    System_Ext(screen, "Екран поштомата")
    System_Ext(scanner, "Сканер служби доставки")
    System_Ext(sms, "SMS-провайдер")
    System_Ext(monitoring, "Моніторинг")

    Container_Boundary(parcel, "Поштомат громади") {
        Container(api, "HTTP API", "Node.js", "Реєстрація та видача посилок, список для персоналу, перевірка стану")
        Container(worker, "SMS worker", "Node.js", "Кожні 30 секунд знаходить посилки без сповіщення та надсилає SMS")
        Container(expiry, "Нічна задача", "Node.js", "Позначає посилки старші за 72 години як повернені")
        ContainerDb(db, "Сховище", "PostgreSQL", "Посилки, події та сесії персоналу")
    }

    Rel(resident, screen, "Вводить код")
    Rel(screen, api, "POST /pickup", "HTTP")
    Rel(courier, scanner, "Сканує посилку")
    Rel(scanner, api, "POST /parcels", "HTTP")
    Rel(staff, api, "GET /admin/parcels", "HTTP")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає та змінює дані")
    Rel(worker, db, "Шукає посилки без сповіщення та оновлює їх")
    Rel(worker, sms, "Надсилає код отримання", "HTTP")
    Rel(sms, resident, "Доставляє SMS")
    Rel(expiry, db, "Позначає прострочені посилки як повернені")
```

**Припущення:** клієнт персоналу не описаний, тому окремий контейнер для нього не показано. Спосіб запуску нічної задачі також не вказаний. Для продакшну показано PostgreSQL; у локальній версії репозиторію сховище працює в пам’яті. API та worker розгортаються в Docker Compose на одній VM, а PostgreSQL працює на цій VM поза контейнерами.
