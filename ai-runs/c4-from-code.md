# Прогін 2 — C4 з коду

- Інструмент і модель: Claude Code (CLI, `claude -p`), Claude Opus 5 — окрема нова сесія
  без історії, прогону 1 не бачила
- Дата: 2026-11-01
- Що бачила сесія: тимчасова тека `../ws11-b-code/` — уся `app/` (`src/`, `bin/`, `test/`,
  `package.json`, `README.md`, `docs/ARCHITECTURE.md`). Створена командою з
  `docs/walkthrough.md`: `mkdir -p ../ws11-b-code && cp -r app ../ws11-b-code/`.
  Кореневих `materials/`, `docs/`, `deploy/`, `incident/` у ній немає — тому
  `deploy/compose.yaml` і `deploy/Dockerfile` сесія не бачила (вона це помітила сама,
  припущення 7).
- Чесно про контекст: прогін виконано як окремий процес `claude -p` із робочою текою
  `../ws11-b-code` — поза репозиторієм, тому кореневих `AGENTS.md`/`CLAUDE.md` цього репо
  сесія не бачила взагалі. Пам'яті між сесіями і глобального `~/.claude/CLAUDE.md` немає.
  Інструменти — лише для читання (`Read, Grep, Glob, Bash(ls|find|wc)`).
- Параметри запуску: `--model claude-opus-5 --output-format json`; 15 ходів, 96.9 с,
  $0.587, 6413 токенів виводу, session `08bcf058-5508-46aa-ac0a-0f3d21cb89d9`.
- Промпт (дослівно) — той самий, що в прогоні 1:

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

Прочитала весь код у `app/`. Нижче — дві діаграми; побудовані **з коду**, а не з `docs/ARCHITECTURE.md`, бо документація місцями розійшлася з реальністю (розбіжності — в кінці).

## Рівень 1 — System Context

```mermaid
C4Context
    title Рівень 1: System Context — «Поштомат громади» (v1.7.3)

    Person(resident, "Мешканець", "Отримує SMS з 6-значним кодом, вводить його на екрані поштомата і забирає посилку")
    Person(delivery, "Працівник служби доставки", "Кладе посилку в комірку і реєструє її сканером")
    Person(staff, "Персонал громади", "Переглядає список посилок (роль staff або admin)")

    System(poshtomat, "Поштомат громади", "Реєструє посилки, видає коди отримання, сповіщає мешканців SMS, через 72 години повертає незабрані посилки відправнику")

    System_Ext(terminal, "Екран поштомата (термінал)", "Пристрій у поштоматі; надсилає введений код у POST /pickup")
    System_Ext(scanner, "Сканер служби доставки", "Надсилає POST /parcels")
    System_Ext(smsProvider, "SMS-провайдер", "HTTP API: POST /messages")
    System_Ext(courierApi, "Служба доставки — API повернень", "HTTP API: POST /returns")
    System_Ext(monitoring, "Моніторинг", "Опитує GET /health")

    Rel(resident, terminal, "Вводить код отримання")
    Rel(delivery, scanner, "Сканує посилку")
    Rel(staff, poshtomat, "Дивиться список посилок", "HTTPS, Bearer-сесія")

    Rel(terminal, poshtomat, "Перевіряє код і відкриває комірку", "HTTP/JSON")
    Rel(scanner, poshtomat, "Реєструє посилку", "HTTP/JSON")
    Rel(poshtomat, smsProvider, "Надсилає SMS з кодом", "HTTP/JSON, Bearer-токен")
    Rel(poshtomat, courierApi, "Замовляє забір незабраної посилки", "HTTP/JSON")
    Rel(smsProvider, resident, "Доставляє SMS з кодом", "SMS")
    Rel(monitoring, poshtomat, "Опитує стан і версію", "HTTP")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Рівень 2 — Container

```mermaid
C4Container
    title Рівень 2: Containers — «Поштомат громади» (v1.7.3)

    Person(resident, "Мешканець", "Забирає посилку за кодом")
    Person(delivery, "Працівник служби доставки", "Реєструє посилку")
    Person(staff, "Персонал громади", "Роль staff / admin")

    System_Ext(terminal, "Екран поштомата", "Пристрій у поштоматі")
    System_Ext(scanner, "Сканер служби доставки", "Пристрій")
    System_Ext(monitoring, "Моніторинг", "Опитує /health")

    System_Boundary(vm, "Одна VM (docker compose) — «Поштомат громади»") {
        Container(api, "API", "Node.js 22, node:http, без фреймворку", "POST /parcels, POST /pickup, GET /admin/parcels, GET /health. Автентифікація персоналу — Bearer-сесія з БД. 503 при таймауті пулу, 403/400 на відмовах. Логи — JSON-lines у stdout")
        Container(worker, "SMS Worker", "Node.js 22, довгоживучий процес", "Кожні 10 с бере до 50 посилок без сповіщення і надсилає SMS з кодом; невдача лишає посилку на наступний раунд")
        Container(expire, "Нічна задача повернень", "Node.js 22, cron на VM", "Знаходить посилки, що лежать понад 72 год, позначає returned і замовляє забір у служби доставки")
        ContainerDb(db, "База даних", "PostgreSQL (на тій самій VM, поза контейнерами)", "Посилки, події, сесії персоналу. Доступ через пул з max з'єднань і таймаутом очікування")
    }

    System_Ext(smsProvider, "SMS-провайдер", "HTTP API")
    System_Ext(courierApi, "API повернень служби доставки", "HTTP API")

    Rel(resident, terminal, "Вводить 6-значний код")
    Rel(delivery, scanner, "Сканує посилку")
    Rel(terminal, api, "POST /pickup", "HTTP/JSON")
    Rel(scanner, api, "POST /parcels", "HTTP/JSON")
    Rel(staff, api, "GET /admin/parcels", "HTTPS, Authorization: Bearer")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Читає/пише посилки, події; шукає сесію", "SQL, пул з'єднань")
    Rel(worker, db, "listUnnotified, updateParcel", "SQL, пул з'єднань")
    Rel(expire, db, "listParcels, updateParcel", "SQL, пул з'єднань")

    Rel(worker, smsProvider, "POST /messages, ≤5 запитів/с, повтори з backoff на 429", "HTTP/JSON")
    Rel(expire, courierApi, "POST /returns, reason=not_picked_up_72h", "HTTP/JSON")
    Rel(smsProvider, resident, "SMS з кодом отримання", "SMS")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Явні припущення

1. **Екран поштомата і сканер — зовнішні системи, не контейнери.** У репозиторії немає їхнього коду, лише HTTP-ендпоїнти, які вони викликають. Якщо прошивка терміналу розробляється в цій же команді, її варто перенести всередину межі системи.
2. **PostgreSQL** взято з `docs/ARCHITECTURE.md` і `DATABASE_URL`. У самому коді (`src/db.js`) сховище — **in-memory**, з тим самим інтерфейсом; README прямо каже, що в продакшні це Postgres. Тобто діаграма описує продакшн, а не те, що запускається з репозиторію.
3. **HTTPS / TLS-термінація** для персоналу позначена умовно. Код слухає звичайний HTTP на порту 8080; реверс-проксі в репозиторії немає. Якщо перед API є nginx/Caddy — це окремий контейнер, якого тут бракує.
4. **Моніторинг** як зовнішній актор — із документації; у коді є лише сам `GET /health`.
5. **Логи** пишуться JSON-рядками в stdout (`src/log.js`), жодного збирача логів у коді немає, тому я його не малювала. Фактично його роль виконує `docker logs` / драйвер логів.
6. **Автентифікація персоналу**: сесії читаються з БД (`findSession`), але **ендпоїнта логіну в коді немає** — сесії створює лише `db.addSession`. Припускаю, що вони заводяться поза цим сервісом (або ще не реалізовані).
7. **`deploy/` з docker compose** згадано в документації, але в наданих файлах є тільки каталог `app/` — схему розгортання (дві реплікації з одного образу, одна VM) взято з документації на віру.
8. **Cron** для нічної задачі — із комментаря в `bin/expire-parcels.js`; самого crontab у репозиторії не видно.

## Розбіжності документації з кодом (варто виправити в `ARCHITECTURE.md`)

| Документація (v1.5) | Код (v1.7.3) |
|---|---|
| Worker опитує кожні **30 с** | `POLL_INTERVAL_MS = 10_000` — **10 с**, пачками по 50; за повної пачки йде наступний раунд без паузи |
| Код отримання **4-значний** | **6-значний** (`padStart(6, "0")`, перевірка `/^\d{6}$/`) |
| Нічна задача лише «позначає посилки поверненими» | Ще й **викликає зовнішній API служби доставки** (`POST /returns`) — цілої зовнішньої системи та `COURIER_BASE_URL` у документації немає |
| `_Оновлено: червень 2026 (v1.5)_` | `package.json` — **1.7.3** |

Окремо зауважу (поза межами C4, але видно з коду): у `expire-parcels.js` посилка спершу позначається `returned`, і лише потім викликається API курьєра — якщо той запит упаде, посилка вже вважається повернутою, а забір не замовлено, і наступний запуск її не підхопить, бо `findExpired` фільтрує тільки `status === "waiting"`.