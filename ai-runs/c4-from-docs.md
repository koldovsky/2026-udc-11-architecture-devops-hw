- Інструмент і модель: Claude Code 2.1.168, headless `claude -p`; модель claude-sonnet-4-6 (модель за замовчуванням CLI; haiku — службові виклики)
- Дата: 2026-11-02
- Що бачила сесія: тимчасова тека ../ws11-b-docs — лише `app/README.md` і `app/docs/`; нова сесія без історії, `--strict-mcp-config` (жодних MCP), інструменти Read/Glob/Grep/Bash. Увімкненим лишився глобальний `~/.claude/CLAUDE.md` (загальні правила керування AI-конфігурацією і ctx7, нічого про цей репо) та глобальні skills; пам'ять нової теки — порожня.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Усе зрозуміло. Ось C4-діаграми.

---

**Припущення:**

- Персонал (адмін) дивиться список посилок через той самий API, а не через окремий UI.
- SMS-провайдер — зовнішня система (наприклад, Twilio або аналог), деталі не відомі.
- Нічна задача (`expire-parcels`) запускається через `cron` або системний планувальник на тій самій VM.
- In-memory DB (`src/db.js`) — лише для локальної розробки; у продакшні — PostgreSQL на тій самій VM, поза Docker.
- Моніторинг — зовнішня система (наприклад, Uptime-кролик / Prometheus-агент), яка опитує `/health`.

---

## Рівень 1 — System Context

```mermaid
C4Context
  title System Context — Поштомат громади

  Person(resident, "Мешканець", "Отримує SMS з кодом і вводить його на екрані поштомата")
  Person(courier, "Служба доставки", "Сканує посилку при закладанні до поштомата")
  Person(staff, "Персонал", "Переглядає список посилок через адмін-ендпоінт")

  System(parcelLocker, "Поштомат громади", "Реєструє посилки, надсилає SMS-коди, дозволяє забрати посилку за кодом")

  System_Ext(smsProvider, "SMS-провайдер", "Зовнішній HTTP API для відправлення SMS-повідомлень")
  System_Ext(lockerScreen, "Екран поштомата", "Вбудований термінал, що надсилає код підтвердження")
  System_Ext(monitoring, "Моніторинг", "Зовнішня система, що опитує /health")

  Rel(courier, parcelLocker, "POST /parcels — реєструє посилку", "HTTP/JSON")
  Rel(resident, lockerScreen, "Вводить 4-значний код")
  Rel(lockerScreen, parcelLocker, "POST /pickup — підтверджує отримання", "HTTP/JSON")
  Rel(staff, parcelLocker, "GET /admin/parcels — перегляд посилок", "HTTP/JSON")
  Rel(parcelLocker, smsProvider, "Надсилає SMS з кодом", "HTTP/JSON")
  Rel(parcelLocker, resident, "SMS з кодом отримання", "SMS")
  Rel(monitoring, parcelLocker, "GET /health — перевірка стану", "HTTP")
```

---

## Рівень 2 — Container

```mermaid
C4Container
  title Container — Поштомат громади

  Person(courier, "Служба доставки")
  Person(resident, "Мешканець")
  Person(staff, "Персонал")

  System_Ext(lockerScreen, "Екран поштомата")
  System_Ext(smsProvider, "SMS-провайдер")
  System_Ext(monitoring, "Моніторинг")
  System_Ext(cron, "Системний планувальник (cron)", "На тій самій VM")

  System_Boundary(vm, "VM (docker compose)") {

    Container(api, "API", "Node.js · src/server.js", "HTTP-сервер: реєстрація посилок, підтвердження отримання, адмін-список, health-check. Порт 8080.")

    Container(worker, "Worker", "Node.js · src/worker.js", "Фоновий процес: кожні 30 с опитує БД і відправляє SMS для посилок без сповіщення.")

    Container(expireJob, "Expire-parcels job", "Node.js · bin/expire-parcels.js", "Нічна задача: позначає посилки старші 72 год як повернені.")

    ContainerDb(postgres, "PostgreSQL", "PostgreSQL (поза Docker, на VM)", "Таблиці: посилки, події, сесії персоналу.")
  }

  Rel(courier, api, "POST /parcels", "HTTP/JSON")
  Rel(lockerScreen, api, "POST /pickup", "HTTP/JSON")
  Rel(staff, api, "GET /admin/parcels", "HTTP/JSON")
  Rel(monitoring, api, "GET /health", "HTTP")

  Rel(api, postgres, "Читає / пише посилки, події, сесії", "TCP/SQL")
  Rel(worker, postgres, "Читає посилки без SMS; оновлює статус", "TCP/SQL")
  Rel(worker, smsProvider, "POST — відправляє SMS з кодом", "HTTP/JSON")
  Rel(worker, resident, "SMS з 4-значним кодом", "SMS")
  Rel(cron, expireJob, "Запускає щоночі")
  Rel(expireJob, postgres, "UPDATE parcels SET status='returned'", "TCP/SQL")
```

---

**Ключові спостереження по архітектурі:**

- `api` і `worker` — окремі контейнери, але зібрані з одного образу; shared-state йде виключно через PostgreSQL.
- PostgreSQL живе поза Docker на тій самій VM — це точка єдиного відмову і потенційна проблема при масштабуванні.
- Немає черги повідомлень між `api` і `worker` — worker поллінгує БД кожні 30 с, що додає затримку до SMS.
