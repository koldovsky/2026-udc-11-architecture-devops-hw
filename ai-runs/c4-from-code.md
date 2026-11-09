- Інструмент і модель: Codex subagent, GPT-6
- Дата: 2026-11-09
- Що бачила сесія: `../ws11-b-code/` — уся `app/` (без історії попередніх прогонів)
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Нижче показано **задокументовану продакшн-архітектуру**. Відмінності між документацією та наявним кодом зазначено після діаграм.

### System Context

```mermaid
C4Context
    title Поштомат громади — System Context

    Person(resident, "Мешканець", "Отримує код і забирає посилку")
    Person(operator, "Працівник доставки", "Реєструє посилку")
    Person(staff, "Персонал", "Переглядає стан посилок")

    System(poshtomat, "Поштомат громади", "Реєстрація, видача, сповіщення та повернення посилок")

    System_Ext(scanner, "Сканер доставки", "Надсилає дані про нову посилку")
    System_Ext(terminal, "Екран поштомата", "Надсилає введений код")
    System_Ext(sms, "SMS-провайдер", "Доставляє SMS мешканцю")
    System_Ext(courier, "API служби доставки", "Приймає заявки на повернення")
    System_Ext(monitoring, "Моніторинг", "Перевіряє доступність сервісу")

    Rel(operator, scanner, "Реєструє посилку")
    Rel(scanner, poshtomat, "POST /parcels")
    Rel(resident, terminal, "Вводить код отримання")
    Rel(terminal, poshtomat, "POST /pickup")
    Rel(staff, poshtomat, "GET /admin/parcels")
    Rel(poshtomat, sms, "Надсилає SMS з кодом")
    Rel(sms, resident, "Доставляє SMS")
    Rel(poshtomat, courier, "POST /returns для прострочених посилок")
    Rel(monitoring, poshtomat, "GET /health")
```

### Container

```mermaid
C4Container
    title Поштомат громади — Container

    Person(resident, "Мешканець")
    Person(staff, "Персонал")
    System_Ext(scanner, "Сканер доставки")
    System_Ext(terminal, "Екран поштомата")
    System_Ext(sms, "SMS-провайдер")
    System_Ext(courier, "API служби доставки")
    System_Ext(monitoring, "Моніторинг")
    System_Ext(cron, "Планувальник на VM", "Запускає нічну задачу")

    System_Boundary(poshtomat, "Поштомат громади") {
        Container(api, "HTTP API", "Node.js", "Реєструє та видає посилки; надає список персоналу і health endpoint")
        Container(worker, "SMS worker", "Node.js", "Опитує посилки без сповіщення й надсилає SMS")
        Container(expiry, "Нічна задача", "Node.js", "Позначає посилки старші за 72 години як повернені")
        ContainerDb(db, "PostgreSQL", "База даних", "Спільні посилки, події та сесії персоналу — за описом продакшну")
    }

    Rel(scanner, api, "POST /parcels", "HTTP/JSON")
    Rel(terminal, api, "POST /pickup", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels з Bearer-сесією", "HTTP/JSON")
    Rel(monitoring, api, "GET /health", "HTTP")
    Rel(resident, terminal, "Вводить код")

    Rel(api, db, "Читає та змінює посилки; перевіряє сесії")
    Rel(worker, db, "Читає посилки без сповіщення; записує час сповіщення")
    Rel(worker, sms, "POST /messages", "HTTP/JSON")
    Rel(sms, resident, "Доставляє код")
    Rel(cron, expiry, "Запускає вночі")
    Rel(expiry, db, "Шукає посилки старші за 72 години; позначає повернення")
    Rel(expiry, courier, "POST /returns", "HTTP/JSON")
```

**Важлива межа достовірності:** `app/docs/ARCHITECTURE.md` описує PostgreSQL у продакшні, але наявний `app/src/db.js` реалізує лише сховище в пам’яті. Кожен окремо запущений процес створює власне сховище; коду підключення до PostgreSQL тут немає. Отже, спільна база на діаграмі Container є **задокументованим припущенням про продакшн**, а не підтвердженою реалізацією цього репозиторію. Код також задає опитування worker кожні 10 секунд і шестизначний код, тоді як архітектурний документ зазначає 30 секунд і чотиризначний код.
