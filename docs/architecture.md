# Архітектура «Поштомата громади» — C4

Діаграми відображають реалізацію в `app/`. Зовнішні клієнти показані лише там, де їхню взаємодію видно в HTTP-обробниках або коментарях коду. Часова задача запускається зовнішнім cron; сам cron не є частиною процесу застосунку.

## Рівень 1 — System Context

```mermaid
C4Context
  title Поштомат громади — System Context
  Person(resident, "Мешканець", "Отримує SMS та вводить код на екрані поштомата")
  System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку")
  System_Ext(locker, "Екран поштомата", "Надсилає код для видачі")
  Person(staff, "Персонал", "Переглядає посилки")
  System_Ext(monitor, "Моніторинг", "Перевіряє health endpoint")
  System(poshtomat, "Поштомат громади", "HTTP API, SMS worker і нічна задача")
  System_Ext(sms, "SMS-провайдер", "Приймає запити на SMS")
  System_Ext(courier, "API служби доставки", "Приймає запити на повернення")

  Rel(scanner, poshtomat, "Реєструє посилку", "HTTP POST /parcels")
  Rel(locker, poshtomat, "Передає код отримання", "HTTP POST /pickup")
  Rel(staff, poshtomat, "Переглядає посилки", "HTTP GET /admin/parcels")
  Rel(monitor, poshtomat, "Перевіряє стан", "HTTP GET /health")
  Rel(poshtomat, sms, "Надсилає arrival SMS", "HTTP POST /messages")
  Rel(sms, resident, "Доставляє SMS з номером поштомата та кодом")
  Rel(poshtomat, courier, "Запитує повернення посилки", "HTTP POST /returns")
```

## Рівень 2 — Container

```mermaid
C4Container
  title Поштомат громади — Container
  Person(resident, "Мешканець")
  System_Ext(scanner, "Сканер служби доставки")
  System_Ext(locker, "Екран поштомата")
  Person(staff, "Персонал")
  System_Ext(monitor, "Моніторинг")
  System_Ext(sms, "SMS-провайдер")
  System_Ext(courier, "Courier API")

  System_Boundary(poshtomat, "Поштомат громади") {
    Container(api, "HTTP API", "Node.js", "Реєстрація посилки, видача, адмінський список і health")
    Container(worker, "SMS worker", "Node.js", "Опитує посилки без arrival SMS і надсилає повідомлення")
    Container(expiry, "Нічна задача", "Node.js, запускається cron", "Знаходить прострочені посилки та запитує повернення")
    ContainerDb(store, "Data store", "In-memory у цьому репозиторії; PostgreSQL для production за коментарем у коді", "Посилки, події, сесії персоналу")
  }

  Rel(scanner, api, "Реєструє посилку", "HTTP POST /parcels")
  Rel(locker, api, "Передає код отримання", "HTTP POST /pickup")
  Rel(staff, api, "Переглядає посилки", "HTTP GET /admin/parcels")
  Rel(monitor, api, "Перевіряє стан", "HTTP GET /health")
  Rel(api, store, "Читає/записує посилки та перевіряє сесії", "Data access")
  Rel(worker, store, "Вибирає не сповіщені посилки й записує notifiedAt", "Data access")
  Rel(worker, sms, "Надсилає текст SMS на номер одержувача", "HTTP POST /messages")
  Rel(sms, resident, "Доставляє SMS")
  Rel(expiry, store, "Знаходить посилки старше 72 годин і змінює їхній статус", "Data access")
  Rel(expiry, courier, "Просить забрати посилку й повернути відправнику", "HTTP POST /returns")
```

## Стрілки і докази

Кожен рядок відповідає взаємодії на діаграмах. Деякі зовнішні взаємодії повторюються на обох рівнях. Докази наведено за кодом застосунку.

| # | Стрілка (звідки → куди: що і як) | Доказ (`файл:рядок`) | AI з документації | AI з коду |
|---|---|---|---|---|
| 1 | Сканер доставки → API: реєструє посилку, `POST /parcels` | `app/src/server.js:38-40`; коментар про scanner: `app/src/parcels.js:34-35` | Є | Є |
| 2 | Екран поштомата → API: надсилає код, `POST /pickup` | `app/src/server.js:42-45`; `app/src/parcels.js:58-61` | Є | Є |
| 3 | Персонал → API: читає список, `GET /admin/parcels` | `app/src/server.js:47-49` | Є | Є |
| 4 | Моніторинг → API: перевіряє `GET /health` | `app/src/server.js:36-37` | Є | Є |
| 5 | API → сховище: читає/записує посилки та перевіряє сесії | `app/src/server.js:13-19,38-49`; `app/src/parcels.js:43-55,61-75` | Є | Є |
| 6 | Worker → сховище: вибирає не сповіщені та записує `notifiedAt` | `app/src/worker.js:23-34`; реалізація списку `app/src/db.js:40-44` | Є | Є |
| 7 | Worker → SMS-провайдер: надсилає номер і текст через HTTP | `app/src/worker.js:26-34`; `app/src/sms.js:27-44` | Є | Є |
| 8 | SMS-провайдер → мешканець: доставляє arrival SMS | `app/src/worker.js:11-13,28`; клієнт передає `to` і `text`: `app/src/sms.js:31-35` | Пропустив — у прогоні є лише `locker → resident`, не `sms → resident` | Пропустив |
| 9 | Нічна задача → сховище: знаходить прострочені, позначає поверненими | `app/bin/expire-parcels.js:11-14`; `app/src/parcels.js:78-87` | Є | Є |
| 10 | Нічна задача → Courier API: просить забрати посилку (`POST /returns`) | `app/bin/expire-parcels.js:15`; `app/src/courier.js:3-18` | Пропустив | Є |

## Що AI вигадав / пропустив

| Прогін | Вигадав — стрілки й компоненти, яких у коді немає | Пропустив — стрілки з таблиці вище, яких немає у відповіді AI |
|---|---|---|
| З документації | 1 стрілку: мешканець → екран поштомата («вводить код»). Документація показує цей крок, але код доводить лише передачу введеного коду терміналом до `POST /pickup`; дії людини на екрані в коді немає. | 2 стрілки: SMS-провайдер → мешканець (№8) і нічна задача → Courier API (№10). У прогоні є `locker → resident`, а не `sms → resident`; у `app/bin/expire-parcels.js:15` задача викликає повернення, а `app/src/courier.js:7-18` виконує HTTP-запит, якого архітектурна документація не показує. |
| З коду | Немає стрілок без опори в коді. | 1 стрілку: SMS-провайдер → мешканець (№8). Показує виклик провайдера, але не доставку повідомлення мешканцю. |

Окремо від стрілок: документаційний прогін повторив застарілі параметри — poll кожні 30 секунд і 4-значний код. Код встановлює 10 секунд (`app/src/worker.js:8,65-66`) та генерує 6 цифр (`app/src/parcels.js:25-28`). Також документація називає PostgreSQL фактичною БД, тоді як `app/src/db.js:1-2` каже, що у цьому репозиторії store in-memory; PostgreSQL описаний як production реалізація того самого інтерфейсу.

**Разом:** з документації — вигадано 1 стрілку, пропущено 2; з коду — вигадано 0, пропущено 1.

## Перевірка меж діаграми

- У коді є `GET /admin/parcels` для персоналу, але немає окремої взаємодії відправника з інтерфейсом статусу повернення; тому такого клієнта на діаграмі немає.
- Worker надсилає arrival SMS. Нагадувань через 24/48 годин у поточному `app/` немає; цієї майбутньої функції на діаграмі немає.
- `app/` не змінювався.
