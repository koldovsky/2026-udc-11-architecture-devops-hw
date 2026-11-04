- Інструмент і модель: Claude Code 2.1.168, headless `claude -p`; модель claude-sonnet-4-6, claude-haiku-4-5-20251001 (модель за замовчуванням CLI; haiku — службові виклики)
- Дата: 2026-11-02
- Що бачила сесія: тимчасова тека ../ws11-a-with — `app/`, `materials/`, `docs/ops/`; нова сесія без історії, `--strict-mcp-config` (жодних MCP), інструменти Read/Glob/Grep/Bash. Увімкненим лишився глобальний `~/.claude/CLAUDE.md` (загальні правила керування AI-конфігурацією і ctx7, нічого про цей репо) та глобальні skills; пам'ять нової теки — порожня.
- Промпт (дослівно):

  > У цій теці — код сервісу «Поштомат громади» (app/). Ми додаємо нову функцію:
  > 1) SMS про прибуття — як і зараз: щойно посилку поклали в комірку, мешканець отримує SMS з номером поштомата і кодом отримання;
  > 2) нагадування — SMS через 24 години і ще одне через 48 годин, якщо посилку досі не забрали;
  > 3) повернення відправнику рівно через 72 години (а не «наступної ночі»): комірка звільняється, посилка вирушає назад, відправник бачить статус.
  > У теці є також `materials/` і `docs/ops/` — прочитай їх перед відповіддю.
  > Запропонуй архітектурне рішення і оформи його як ADR у форматі Nygard
  > (Context, Decision, Consequences) з щонайменше двома альтернативами та їхніми компромісами.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---
Маю повну картину коду, матеріалів і операційних обмежень. Ось ADR.

---

## ADR-001: Нагадувальні SMS та точне 72-годинне повернення

**Дата**: 2026-11-02  
**Статус**: Proposed  
**Автор**: (запропоновано AI-асистентом)

---

### Context

**Поточний стан системи**

Сервіс «Поштомат громади» (v1.7.3) вміє одне: щойно кур'єр кладе посилку, `worker.js` кожні 10 секунд вибирає рядки з `notifiedAt IS NULL` і надсилає SMS із кодом отримання. Повернення відправнику виконує окремий cron-скрипт `npm run expire` о **03:15 за Києвом** — не «через 72 години», а «наступного разу, коли запустимо job».

**Нові вимоги (feature-brief)**

| # | Вимога | Пріоритет |
|---|--------|-----------|
| R1 | SMS про прибуття — вже є | — |
| R2 | Нагадування через 24 год, якщо не забрали | High |
| R3 | Нагадування через 48 год | Low (defer OK) |
| R4 | Повернення **рівно** через 72 год, комірка звільнюється | High |
| R5 | Немає SMS 21:00–08:00 за Києвом (юридична вимога) | Mandatory |
| R6 | Ідемпотентність — жодного дублікату SMS при краші процесу | Mandatory |

**Обмеження, виявлені з матеріалів**

- **Один VM**, docker-compose, без Kubernetes; два розробники без k8s-досвіду.  
- **Zero external dependencies** — у `package.json` немає жодної npm-залежності; Redis, RabbitMQ, Kafka виключені.  
- **Бюджет**: 0.035 €/SMS, ліміт 60 €/міс на ІТ-інфраструктуру (SMS з окремого бюджету).  
- **Privacy/GDPR**: всі дані — лише в EU (Frankfurt VM + PostgreSQL).  
- **Backup window**: БД заблокована на запис 02:00–02:30; job о 03:15 запускається після backup.  
- **Rate limit SMS-провайдера**: 10 msg/sec; 429 → exponential backoff уже реалізований у `sms.js`.

**Поточний технічний борг / баги**

1. `worker.js` не перевіряє тихий годинний діапазон — наразі може відправляти SMS уночі (прихований баг).
2. `expire-parcels.js` залежить від конкретного часу запуску cron, а не від реального `arrivedAt + 72h`.

**Явні припущення**

- A1: SMS про прибуття теж підпадає під правило 21:00–08:00; людина, чия посилка прибула о 22:00, отримає SMS після 08:00.  
- A2: Сама дія «повернення» (зміна статусу + запит до courier API) **не** блокується тихим вікном — лише SMS.  
- A3: Один інстанс `worker`-процесу (без горизонтального масштабування), тому row-level locking зайвий.  
- A4: SMS відправнику при поверненні — опціонально (legal-notes: «рекомендовано, але не обов'язково»); в першій ітерації не реалізуємо.  
- A5: «Рівно 72 год» означає «не раніше ніж через 72 год»; затримка до 10 секунд (один polling-цикл) прийнятна.

---

### Alternatives Considered

#### Альтернатива A — Нові стовпці на таблиці `parcels`

Додати два nullable-стовпці:

```sql
ALTER TABLE parcels
  ADD COLUMN reminder1_sent_at TIMESTAMPTZ,
  ADD COLUMN reminder2_sent_at TIMESTAMPTZ;
```

Розширити `worker.js` ще двома запитами на polling-цикл:

```js
// 24h reminder
SELECT * FROM parcels
WHERE status='waiting'
  AND arrived_at <= now() - INTERVAL '24 hours'
  AND reminder1_sent_at IS NULL
LIMIT 50;

// 48h reminder
SELECT * FROM parcels
WHERE status='waiting'
  AND arrived_at <= now() - INTERVAL '48 hours'
  AND reminder2_sent_at IS NULL
LIMIT 50;
```

Повернення: замінити cron о 03:15 на запуск `npm run expire` кожні 5 хвилин, або перенести логіку в worker.

**Переваги A**:
- Мінімальна міграція — лише два стовпці.
- Концептуально знайомо: той самий патерн `notifiedAt IS NULL`, просто двічі.
- Немає нових сутностей.

**Недоліки A**:
- Таблиця `parcels` стає «смітником станів»: кожен новий тип сповіщення → новий стовпець.
- Складніше скасовувати: якщо посилку забирають під час quiet-window, треба перевіряти статус перед кожним SMS + не чіпати вже-стовпці.
- Важко сказати «які сповіщення заплановані / чекають»; немає audit trail для нотифікацій.
- 72-годинне повернення: або другий cron кожні 5 хвилин (race condition із backup-lock 02:00–02:30), або безпосередньо в worker (worker стає ще складнішим).
- При зростанні вимог (наприклад, +96h, або SMS відправнику) — множимо стовпці.

---

#### Альтернатива B — Dedicated `scheduled_notifications` table *(Рекомендована)*

Окрема таблиця-черга в тій самій PostgreSQL:

```sql
CREATE TABLE scheduled_notifications (
  id           SERIAL PRIMARY KEY,
  parcel_id    INTEGER NOT NULL REFERENCES parcels(id),
  type         TEXT    NOT NULL,  -- 'arrival','reminder_24h','reminder_48h','return'
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,       -- NULL = ще не виконано
  skipped_at   TIMESTAMPTZ,       -- NULL або момент скасування
  skip_reason  TEXT                -- 'picked_up', 'returned'
);
```

При реєстрації посилки (`registerParcel`) — одна транзакція вставляє 4 рядки:

```
arrival      → scheduled_at = now()
reminder_24h → scheduled_at = arrivedAt + 24h
reminder_48h → scheduled_at = arrivedAt + 48h
return       → scheduled_at = arrivedAt + 72h
```

Worker кожні 10 секунд:

```sql
SELECT sn.*, p.locker_id, p.code, p.recipient_phone, p.status
FROM scheduled_notifications sn
JOIN parcels p ON p.id = sn.parcel_id
WHERE sn.sent_at IS NULL
  AND sn.skipped_at IS NULL
  AND sn.scheduled_at <= now()
ORDER BY sn.scheduled_at
LIMIT 50;
```

Для кожного рядка:

1. **Якщо `p.status != 'waiting'`** → `skipped_at = now(), skip_reason = p.status` → continue.
2. **Якщо `type = 'return'`** → викликати `markReturned()` + `courier.requestReturn()` → `sent_at = now()`. Quiet window не застосовується.
3. **Якщо `type` є SMS-типом** → перевірити Kyiv-hour:
   - 21:00–08:00 → **не позначати** `sent_at`, пропустити цей елемент у поточному циклі; наступний polling підхопить його після 08:00.
   - Інакше → відправити SMS → `sent_at = now()`.

**Night-hour перевірка** (додається в `worker.js` або виноситься в `sms.js`):

```js
function isQuietHour() {
  // Kyiv = Europe/Kiev = UTC+2 (winter) / UTC+3 (summer)
  // Простий варіант без зовнішніх залежностей:
  const kyivOffset = getKyivOffsetMs(); // визначається через Date.prototype, без TZ-lib
  const kyivHour = new Date(Date.now() + kyivOffset).getUTCHours();
  return kyivHour >= 21 || kyivHour < 8;
}
```

> Про DST: Kyiv переходить на UTC+2/UTC+3 разом з Україною. Правило «21:00–08:00» прив'язане до локального часу. Можна обрахувати без зовнішньої TZ-бібліотеки, бо `Intl.DateTimeFormat` доступний у Node 22 із вбудованих ICU-даних.

**Повернення точно о 72 год**: worker працює безперервно, тому рядок `type='return'` з `scheduled_at = arrivedAt + 72h` буде оброблений протягом 10 секунд після настання моменту. Backup-lock 02:00–02:30 блокує INSERT/UPDATE, але `withConnection` у `db.js` вже має `PoolTimeoutError` з timeout 2000ms — worker просто пропустить одну ітерацію і спробує наступну.

**Скасування при pickup**: у функції `pickup()` в `parcels.js` додати:

```js
// після markPickedUp():
await db.cancelPendingNotifications(parcelId, 'picked_up');
// UPDATE scheduled_notifications
//   SET skipped_at=now(), skip_reason='picked_up'
// WHERE parcel_id=$1 AND sent_at IS NULL
```

**Переваги B**:
- Ідемпотентність кристально чиста: `sent_at IS NULL AND skipped_at IS NULL`.
- Повний audit trail: можна запитати «які SMS відправлені/пропущені для посилки #42».
- Нові типи сповіщень (96h, SMS відправнику при поверненні) — лише новий рядок при реєстрації, без міграції стовпців.
- `parcels`-таблиця не розростається.
- Повернення рівно о 72h без зміни cron-конфігурації.
- Quiet-window логіка ізольована в одному місці.

**Недоліки B**:
- Одна нова таблиця + міграція.
- `registerParcel` тепер робить 5 INSERT замість 1 (в одній транзакції — нормально).
- Треба скасовувати рядки при pickup (додатковий UPDATE).
- Backup-lock 02:00–02:30: якщо якраз у цей момент спливає 72 год → worker отримає `PoolTimeoutError` і спробує ще раз через 10 секунд. Затримка повернення ≤ 30 хвилин у гіршому випадку (тривалість блокування). *Компроміс прийнятний* — backup-window відома заздалегідь, і затримка ≪24 год.

---

#### Альтернатива C — Кілька cron-скриптів

Додати окремі cron-задачі: `send-reminders.js` кожні 5 хвилин + `expire-parcels.js` кожні 5 хвилин. Стан зберігається або в стовпцях (як Alt A), або в окремій таблиці (як Alt B).

**Переваги C**:
- Кожен скрипт простий і ізольований; легко запустити вручну для дебагу.
- Знайомий операційний патерн (команда вже використовує cron).

**Недоліки C**:
- **Precision**: cron кожні 5 хвилин → повернення може запізнитися на 5 хвилин (це допустимо) — але і backup-lock о 02:00 та job о 02:01 можуть конфліктувати.
- **Race condition**: якщо попередній запуск ще не завершився, а cron стартує новий — треба advisory lock або lock-файл. Жоден з них не реалізований зараз.
- **Quiet-window**: cron-скрипт надсилає SMS, коли запускається, без урахування часу — потрібна та ж перевірка, що і в worker.
- Більше cron-записів у `crontab` → операційна складність зростає.
- Ніякого переваги перед Альтернативою B при рівній складності.

---

### Decision

**Обираємо Альтернативу B — таблиця `scheduled_notifications` як черга в PostgreSQL.**

**Обґрунтування вибору:**

1. **Ідемпотентність без додаткового коду**: предикат `sent_at IS NULL AND skipped_at IS NULL` є атомарним — при краші процесу між SELECT і UPDATE рядок залишається «неопрацьованим» і підхопиться на наступному polling-циклі. Це усуває «зимовий інцидент» з дублікатами кодів.

2. **72-годинна точність без змін в cron**: worker вже запущений безперервно. Рядок `type='return'` з `scheduled_at = arrivedAt + 72h` обробляється у межах одного 10-секундного циклу після настання часу. Cron-job `npm run expire` о 03:15 можна залишити як safety-net (або видалити після стабілізації).

3. **Quiet-window в одному місці**: перевірка `isQuietHour()` реалізується один раз у worker-циклі; жодний скрипт, жоден шлях коду не надсилає SMS обхідним шляхом.

4. **Масштабованість вимог**: feature-brief передбачає, що 48h нагадування «можна відкласти», а в майбутньому може з'явитися SMS відправнику при поверненні. З таблицею-чергою це один новий рядок INSERT при реєстрації і, можливо, новий `type` — без міграцій стовпців.

5. **Відповідність стеку команди**: zero external deps зберігається, нова таблиця в уже наявній PostgreSQL, worker продовжує працювати як systemd-сервіс через docker-compose.

---

### Consequences

#### Позитивні наслідки

- **Точне 72-годинне повернення**: комірка звільняється у межах 10 секунд від `arrivedAt + 72h`, а не «наступної ночі о 03:15».
- **Немає нічних SMS**: єдина `isQuietHour()`-перевірка покриває всі типи сповіщень, включаючи вже наявне arrival-SMS (виправляє прихований баг).
- **Стійкість до збоїв**: при краші worker перезапускається (systemd `Restart=on-failure`) і обробляє всі `sent_at IS NULL` записи — жодного пропуску, жодного дублікату.
- **Аудит сповіщень**: `SELECT * FROM scheduled_notifications WHERE parcel_id = $1` одразу показує, що, коли і чому пропущено — корисно під час on-call.
- **Безпека бюджету**: quiet-window зменшує кількість SMS, що відправляються у «незручний» час (нічні посилки не генерують SMS о 22:00), без ризику їх втрати.

#### Негативні наслідки / компроміси

- **DB міграція**: потрібен `CREATE TABLE scheduled_notifications` + `ALTER TABLE parcels` (якщо залишаємо `notifiedAt` для arrival або видаляємо його). Andriy відповідає за міграцію; потрібна координація з backup-window.
- **registerParcel робить 5 INSERT**: в одній транзакції це атомарно і несуттєво за продуктивністю, але код тесту `parcels.test.js` потребує оновлення.
- **Скасування при pickup**: `pickup()` тепер робить 2 UPDATE замість 1. Якщо `cancelPendingNotifications` провалиться після `markPickedUp` (наприклад, connection drop), посилка буде `picked_up`, але рядки `scheduled_notifications` залишаться `sent_at IS NULL`. Worker спробує надіслати SMS → перевірить `p.status != 'waiting'` → поставить `skipped_at`. Кінцевий стан коректний; затримка — один polling-цикл.
- **Backup-lock ризик для 72h**: якщо `arrivedAt + 72h` потрапляє на 02:00–02:30 — worker отримає `PoolTimeoutError` і виконає повернення з затримкою до 30 хвилин. Прийнятний компроміс (документується в runbook).
- **DST Kyiv**: `isQuietHour()` без зовнішньої TZ-бібліотеки потребує обережної реалізації через `Intl.DateTimeFormat('uk', {timeZone:'Europe/Kiev'})`. При зміні DST (остання неділя березня/жовтня) правило автоматично відпрацює правильно, якщо використовуємо IANA-назву зони, а не hardcoded offset.

#### Нейтральні зміни / що залишається незмінним

- `sms.js`, `courier.js`, `config.js`, `log.js` — без змін.
- `server.js` — без змін.
- Cron о 03:15 можна тимчасово залишити як safety-net; після стабілізації — видалити або перетворити на health-check (перевіряє, чи є `scheduled_at < now() - 5 min AND sent_at IS NULL`).
- Delivery reports (webhooks від SMS-провайдера) — поки не реалізовані і не входять у scope цього ADR.
- SMS відправнику при поверненні — поза scope; архітектура це підтримує: додати `type='return_sender'` до INSERT при реєстрації.

---

### Implementation Sketch

```
parcels.js
  registerParcel()
    INSERT INTO parcels ... RETURNING id, arrived_at
    INSERT INTO scheduled_notifications (parcel_id, type, scheduled_at) VALUES
      ($id, 'arrival',      $arrivedAt),
      ($id, 'reminder_24h', $arrivedAt + 24h),
      ($id, 'reminder_48h', $arrivedAt + 48h),
      ($id, 'return',       $arrivedAt + 72h)

  pickup(code)
    ... existing logic ...
    UPDATE scheduled_notifications
      SET skipped_at=now(), skip_reason='picked_up'
      WHERE parcel_id=$id AND sent_at IS NULL

worker.js  (замість поточного notifyArrivals)
  processDueNotifications({pool, sms, courier, log})
    SELECT ... WHERE sent_at IS NULL AND skipped_at IS NULL
                 AND scheduled_at <= now() LIMIT 50
    FOR EACH row:
      if parcel.status != 'waiting':
        UPDATE skipped_at=now(), skip_reason=parcel.status
        continue
      if row.type == 'return':
        markReturned(parcel.id)
        courier.requestReturn(parcel)
        UPDATE sent_at=now()
        continue
      if isQuietHour():
        continue  // не чіпаємо sent_at — підхопимо після 08:00
      sms.send(parcel.recipientPhone, template(row.type, parcel))
      UPDATE sent_at=now()

  isQuietHour():
    const formatter = new Intl.DateTimeFormat('uk', {
      timeZone: 'Europe/Kiev', hour: 'numeric', hour12: false
    })
    const h = parseInt(formatter.format(new Date()))
    return h >= 21 || h < 8
```

**SMS-шаблони** (фінальний текст узгоджує Olena з комунікаційним відділом):

```
arrival:      "Посилка чекає у поштоматі №{lockerId}. Код: {code}"  ← вже є
reminder_24h: "Нагадування: ваша посилка у поштоматі №{lockerId}. Код: {code}. Чекає до {deadline}."
reminder_48h: "Останнє нагадування: посилку з поштомату №{lockerId} буде повернено відправнику через 24 год. Код: {code}."
```

> `{deadline}` = `arrivedAt + 72h`, форматовано як `ДД.ММ о ГГ:ХХ` — потребує того ж `Intl.DateTimeFormat` без зовнішніх залежностей.

---

**Підсумок**: ADR рекомендує ввести таблицю-чергу `scheduled_notifications` у наявну PostgreSQL. Це дає точний 72-годинний тригер через polling-worker, надійну ідемпотентність через `sent_at IS NULL`, централізовану quiet-window перевірку та чистий audit trail — без будь-яких нових зовнішніх залежностей і без змін у операційній інфраструктурі VM.
