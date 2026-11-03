# Архітектурні обмеження для ADR-0001

Обмеженням вважаю вимогу, яка відкидає частину варіантів або змушує додати архітектурне рішення. «Так» означає, що прогін реально пристосував рішення до факту.

| # | Обмеження | Джерело (`файл:рядок`) | Прогін 1 — без матеріалів | Прогін 2 — з матеріалами | Фінальний ADR |
|---:|---|---|---|---|---|
| 1 | Основний канал — SMS; push і застосунок поза scope. | `materials/feature-brief.md:14-16`, `49-53` | так — планує SMS | так — планує SMS | Context/Decision: лише SMS; інші канали — майбутнє. |
| 2 | Потрібні arrival SMS, нагадування через 24/48 годин і повернення рівно через 72 години. | `materials/feature-brief.md:20-28` | так — усі таймери | так — усі таймери | Decision: чотири jobs. |
| 3 | Код не має губитися після падіння і не має надсилатися двічі. | `materials/feature-brief.md:30-35` | так — outbox/retry/idempotency | так — outbox/унікальні ключі | Context, Decision «Події та outbox». |
| 4 | Пріоритет — arrival, 24h, 48h; 48h можна відкласти при скороченні scope. | `materials/feature-brief.md:20-28` | ні — пріоритет не заданий | ні — планує все без degradation policy | Context фіксує пріоритет; повний обсяг свідомо збережено. |
| 5 | SMS заборонені з 21:00 до 08:00 за Києвом. | `materials/legal-notes.md:10-12` | ні | так — перенос на 08:00 | Decision «Надсилання SMS». |
| 6 | Повернення через 72h дозволене; SMS відправнику бажане, але не обов'язкове. | `materials/legal-notes.md:14-17` | ні | так — return обов'язковий, SMS не блокер | Decision про `return_72h`. |
| 7 | Інфраструктура — не більше 60 €/місяць; SMS окремо. | `materials/budget.md:24-31` | ні — додаткова інфраструктура без бюджету | так — без окремого брокера | Alternatives/Consequences. |
| 8 | Одна оплачена VM; поточна експлуатація — Compose, systemd, cron. | `materials/budget.md:10-12`, `materials/team.md:10-13` | ні | ні — сумісність є, але обмеження явно не сформульоване | Context і Decision фіналізують VM-сумісний worker. |
| 9 | Двоє розробників без production Kubernetes; складність має бути посильною. | `materials/team.md:10-13` | ні | так — DB polling замість нової платформи | Alternatives: broker/workflow відхилено. |
| 10 | Телефон і похідні дані — лише в ЄС: БД, черги, логи, сервіси. | `materials/compliance.md:8-13` | ні | ні — EU-резидентність не доведена | Decision: PostgreSQL/logs/integrations у ЄС. |
| 11 | API провайдера має Bearer token, provider ID і delivery webhook із повторами. | `materials/vendors/sms-provider.md:11-15` | ні | так — provider ID/webhook | Decision «Надсилання SMS». |
| 12 | Ліміт провайдера — 10 SMS/с; понад нього 429, SMS не надсилається. | `materials/vendors/sms-provider.md:16-17` | ні | так — rate limit/retry | Decision «Надсилання SMS». |
| 13 | Повторний запит — нове платне SMS; exactly-once не гарантується. | `materials/vendors/sms-provider.md:18-19` | ні | так — ризик дубля/backoff | Decision/Consequences: без exactly-once. |
| 14 | 02:00–02:30 PostgreSQL блокує записи, читання працюють. | `docs/ops/backup-runbook.md:7-16` | ні | так — retry блокувань | Decision «Відновлення та експлуатація». |
| 15 | Backup зберігає 14 днів; restore може відкотити стан приблизно на 10 хвилин. | `docs/ops/backup-runbook.md:10-14`, `30-37` | ні | так — перевірка pending/reconciliation | Decision/Consequences. |
| 16 | Піки — 200–300 посилок за кілька хвилин; SMS не має блокувати API. | `materials/feature-brief.md:41-47` | так — async worker | так — API + outbox | Context/Decision. |
| 17 | Нічний 03:15 cron повертає із запізненням; deadline рахується від `arrivedAt`. | `materials/feature-brief.md:10-12`, `docs/ops/backup-runbook.md:18-19` | так — частий polling | так — worker deadline | Context/Decision «Точне повернення». |

## Підсумок

**Без матеріалів 5 з 17, з матеріалами 14 з 17.**

N — 17 рядків таблиці; X і Y — кількість «так» у відповідних колонках.

## Що AI вигадало або переплутало

Перший прогін припускав PostgreSQL, broker, durable scheduler і workflow engine, хоча матеріали описують одну VM, Compose/cron і двох розробників; також пропустив нічну заборону та тарифікацію повторів. Другий прогін краще врахував провайдера, вікно SMS і backup, але не довів EU-резидентність і не сформулював політику скорочення scope. Це явно закрито або позначено у фінальному ADR.
