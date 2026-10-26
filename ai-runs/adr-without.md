- Інструмент і модель: Claude Code CLI 2.1.304, headless-режим (`claude -p`, дозволені лише інструменти Read/Grep/Glob/LS), модель claude-sonnet-4-6
- Дата: 2026-10-26
- Що бачила сесія: тимчасова тека `../ws11-a-without/` поруч із репо — лише копія `app/`. Нова сесія без історії й без підказок; глобального `~/.claude/CLAUDE.md` немає, у батьківських теках CLAUDE.md / AGENTS.md немає. Сесію запустив агент (GitHub Copilot) з терміналу; нижче — фінальна відповідь сесії (`result` з JSON-виводу) без змін.
- Промпт (дослівно):

  > У цій теці — код сервісу «Поштомат громади» (app/). Ми додаємо нову функцію:
  > 1) SMS про прибуття — як і зараз: щойно посилку поклали в комірку, одержувач отримує номер поштомата і код отримання;
  > 2) нагадування одержувачу через 24 години і ще раз через 48 годин, якщо посилку досі не забрали;
  > 3) повернення відправнику рівно через 72 години (а не «наступної ночі»): комірка звільняється, посилка їде назад, відправник бачить статус.
  > Запропонуй архітектурне рішення і оформи його як ADR у форматі Nygard
  > (Context, Decision, Consequences) з щонайменше двома альтернативами та їхніми компромісами.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Ось ADR, складений на основі реального коду сервісу.

---

# ADR-004: Планові SMS-сповіщення та точне повернення посилок

**Статус:** Proposed — 2026-10-26

---

## Context

Сервіс «Поштомат громади» розгорнутий на одній VM через `docker compose` (два контейнери — `api` та `worker`), PostgreSQL — поза контейнерами, без runtime-залежностей (тільки Node ≥22 built-ins).

**Поточний стан коду:**

| Компонент | Що робить | Де живе |
|---|---|---|
| `worker.js` | Опитує БД кожні 10 с, знаходить `notifiedAt IS NULL`, надсилає SMS про прибуття, пише `notifiedAt` | довготривалий процес |
| `bin/expire-parcels.js` | Знаходить посилки з `arrivedAt <= now − 72h`, ініціює повернення | **нічний cron** |
| `parcels.js` | Бізнес-логіка; `RETURN_AFTER_MS = 72h` | модуль |
| `db.js` | In-memory store (виробничий код підключить PostgreSQL) | модуль |

**Ключові прогалини:**

1. `expire-parcels.js` запускається раз на добу → реальна затримка між настанням 72-ї години і поверненням може сягати ≈24 год.
2. Схема `parcels` містить лише `notifiedAt` (час arrival-SMS); немає жодного поля для нагадувань.
3. `listUnnotified` повертає тільки `notifiedAt IS NULL` — нагадувань немає взагалі.

**Вимоги, що додаються:**

- R1 SMS про прибуття — без змін (вже працює).
- R2 Нагадування одержувачу через **+24 год** після розміщення (якщо не забрав).
- R3 Нагадування одержувачу через **+48 год** (якщо не забрав).
- R4 Повернення відправнику рівно через **+72 год**: комірка звільняється, кур'єр отримує запит, відправник бачить статус.

**Припущення (явні):**

- A1. PostgreSQL використовується у production; `db.js` — тест-стаб; усі нові запити проектуються для PG.
- A2. Одна репліка `worker` (якщо у майбутньому їх стане кілька — рішення масштабується без змін).
- A3. SMS-провайдер підтримує idempotency key або принаймні не каратиме за рідкісний повторний запит.
- A4. Нові текстові шаблони SMS (`reminder24Text`, `reminder48Text`, `returnedSenderText`) технічно тривіальні — в ADR деталі не розкриваються.

---

## Decision

**Вводимо таблицю `parcel_jobs` (planned-job queue) у PostgreSQL і розширюємо наявний `worker.js` для її опитування.**

### Нова таблиця

```sql
CREATE TABLE parcel_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id     UUID        NOT NULL REFERENCES parcels(id),
  job_type      TEXT        NOT NULL,   -- 'reminder_24h' | 'reminder_48h' | 'return_72h'
  run_at        TIMESTAMPTZ NOT NULL,
  executed_at   TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ
);

CREATE INDEX idx_parcel_jobs_pending
  ON parcel_jobs (run_at)
  WHERE executed_at IS NULL AND cancelled_at IS NULL;
```

### Зміни в `parcels.js` — `registerParcel`

Після вставки посилки, в одній транзакції, вставляємо три записи:

```
T + 24h  →  reminder_24h
T + 48h  →  reminder_48h
T + 72h  →  return_72h
```

### Зміни в `parcels.js` — `pickup`

```sql
UPDATE parcel_jobs
   SET cancelled_at = now()
 WHERE parcel_id = $1
   AND executed_at IS NULL
   AND cancelled_at IS NULL;
```

Одна атомарна операція скасовує всі три заплановані події.

### Зміни в `worker.js` — новий цикл `processPendingJobs`

```js
const jobs = await pool.query(`
  SELECT j.*, p.recipient_phone, p.locker_id, p.code, p.sender_phone
    FROM parcel_jobs j
    JOIN parcels p ON p.id = j.parcel_id
   WHERE j.run_at <= now()
     AND j.executed_at IS NULL
     AND j.cancelled_at IS NULL
   LIMIT 50
     FOR UPDATE SKIP LOCKED
`);

for (const job of jobs.rows) {
  if (job.job_type === 'reminder_24h' || job.job_type === 'reminder_48h') {
    await sms.send(job.recipient_phone, reminderText(job));
  } else if (job.job_type === 'return_72h') {
    await parcels.markReturned(job.parcel_id);
    await courier.requestReturn(job.parcel_id);
    await sms.send(job.sender_phone, returnedSenderText(job));
  }
  await pool.query(
    `UPDATE parcel_jobs SET executed_at = now() WHERE id = $1`,
    [job.id]
  );
}
```

Цикл запускається кожні 10 с (той самий інтервал, що й `notifyArrivals`). `FOR UPDATE SKIP LOCKED` запобігає дублюванню при горизонтальному масштабуванні worker.

### Доля `bin/expire-parcels.js`

Залишається як **safety-net** (запускати раз на годину замість ночі). Основна логіка повернення переходить у worker. Дублювання унеможливлене: якщо `return_72h`-джоб уже виконано, `markReturned` знайде статус `returned` і є-ідемпотентним.

---

## Alternatives Considered

### Альтернатива A: Розширені polling-запити в наявному worker без окремої таблиці

Додати в таблицю `parcels` колонки `reminder24SentAt`, `reminder48SentAt` і відповідні запити у worker:

```sql
-- нагадування 24 год
WHERE status = 'waiting'
  AND notified_at IS NOT NULL
  AND arrived_at <= now() - INTERVAL '24 hours'
  AND reminder24_sent_at IS NULL
```

**Переваги:**
- Мінімум змін: 2 нові колонки, 3 нові SELECT-запити.
- Не потрібна нова таблиця або міграція складнішого рівня.
- Легко зрозуміти — вся логіка в одному місці.

**Недоліки:**
- Кожен новий тип сповіщення = ще одна nullable-колонка в `parcels` → схема деградує.
- Скасування при `pickup` потребує оновлення кількох окремих колонок; легко пропустити одну.
- Немає audit trail: якщо нагадування не пішло — незрозуміло чому.
- Час нагадування жорстко прив'язаний до `arrivedAt`: якщо бізнес-логіка зміниться ("нагадувати через 12 год після першого нагадування"), треба переписувати схему.

**Вирок:** відхилено через погану розширюваність і відсутність скасування як першокласної операції.

---

### Альтернатива B: Зовнішній планувальник — часта cron-задача або Redis-черга

**Варіант B1 — часта cron** (`*/5 * * * *`):

Запускати `bin/scheduled-tasks.js` кожні 5 хвилин. Один скрипт обробляє нагадування і повернення.

Переваги: проста реалізація, без змін у схемі БД.  
Недоліки: ±5-хвилинна похибка; паралельні запуски без idempotency-захисту дублюватимуть SMS; стан "вже надіслано" однаково треба десь зберігати — повертаємось до колонок з Альтернативи A.

**Варіант B2 — Bull/BullMQ + Redis:**

```js
// при реєстрації посилки
await queue.add('reminder', { parcelId }, { delay: 24 * 3600 * 1000 });
```

Worker-процес обробляє джоби через BullMQ API.

Переваги: точний таймінг (до секунди), вбудована retry-логіка з backoff, UI для моніторингу (Bull Board).  
Недоліки: новий інфраструктурний компонент (Redis); нова npm-залежність (`bullmq`) — суперечить поточній архітектурі "без runtime-deps"; ризик втрати джобів при перезапуску без Redis AOF persistence; ускладнена операційна модель на одній VM.

**Вирок:** відхилено — надмірна складність для поточного масштабу, суперечить обмеженню на нові залежності.

---

## Consequences

### Позитивні

- **Точність повернення** — з похибкою до інтервалу polling (≈10 с), а не до наступного ранку.
- **Атомарне скасування** при отриманні: один UPDATE `cancelled_at` закриває всі три заплановані події.
- **Розширюваність** — новий тип сповіщення = один рядок у `registerParcel` + один `case` в worker; схема `parcels` не змінюється.
- **Audit trail** — таблиця `parcel_jobs` із `executed_at` / `cancelled_at` дає повну картину: що сталося, коли і чи було скасовано.
- **Горизонтальне масштабування** — `FOR UPDATE SKIP LOCKED` дає змогу запустити кілька реплік worker без дублювання без будь-яких додаткових змін.

### Негативні / ризики

- **Міграція схеми** — потрібен `CREATE TABLE parcel_jobs` до деплою; якщо міграційного інструменту ще немає — треба додати (хоча б `db/migrate.js`).
- **Транзакційність `registerParcel`** — наразі, судячи з коду, окремі INSERT; треба загорнути в транзакцію, щоб посилка і три джоби або всі потрапили в БД, або жоден.
- **Розширення in-memory стабу (`db.js`)** — для unit-тестів потрібна підтримка `parcel_jobs`; без цього `worker.test.js` та нові тести не запустяться.
- **Повторна доставка SMS** — якщо worker впаде після відправки SMS, але до запису `executed_at`, наступний запуск надішле SMS повторно. Мітигація: передавати `job.id` як idempotency key до SMS-провайдера (`sms.js` вже має retry-логіку, треба додати ключ).
- **Зростання таблиці `parcel_jobs`** — 3 рядки на посилку; рекомендований `DELETE ... WHERE executed_at < now() - INTERVAL '30 days'` як фонова задача або партиціонування за `run_at` у майбутньому.
