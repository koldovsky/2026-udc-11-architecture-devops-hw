- Інструмент і модель: Claude Code, Claude Opus 5.5
- Дата: 2026-11-04
- Що бачила сесія: тимчасова тека `ws11-a-with` з копією `app/`, `materials/` і `docs/ops/`;
  сесія читала лише цю ізольовану копію.
- Промпт (дослівно, плейсхолдер `<три пункти…>` так і лишився незаповненим):

  > У цій теці — код сервісу «Поштомат громади» (app/). Ми додаємо нову функцію:
  > <три пункти з розділу «Що хочемо», своїми словами>.
  > Запропонуй архітектурне рішення і оформи його як ADR у форматі Nygard
  > (Context, Decision, Consequences) з щонайменше двома альтернативами та їхніми компромісами.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.
  > У теці є також `materials/` і `docs/ops/` — прочитай їх перед відповіддю.

---

# ADR-001: Parcel notifications and timers in a PostgreSQL scheduling table

**Status:** Proposed, nothing implemented or tested
**Date:** 2026-11-04

Your prompt still had the `<три пункти…>` placeholder, so I took the scope from "Що хочемо" in `materials/feature-brief.md`. This is in English because of this session's language setting, but `team.md` says documentation is written in Ukrainian, so it needs translating before it goes to the executive committee.

## Context

**What we're adding, in priority order:**
1. An arrival SMS with the locker number and pickup code.
2. Reminders at 24 and 48 hours if the parcel hasn't been collected. The 48-hour one can be cut.
3. Return to sender at exactly 72 hours, rather than the next night.

A worker crash must not lose a code or send the same code twice.

**Constraints**

| Constraint | Source | Effect on the design |
|---|---|---|
| No SMS to recipients 21:00–08:00 Kyiv time | `legal-notes.md` | Overrides "as soon as it arrives" in the brief |
| Writes wait or fail 02:00–02:30 Kyiv time | `backup-runbook.md` | Returns due in this window can't run on time |
| Infrastructure limit of €60/month; about €5 used; next budget meeting in March | `budget.md` | Spending more needs a committee decision |
| Phone numbers stay in the EU, including queues, logs and every service they pass through | `compliance.md` | Limits the choice of queue and what logs and alerts can contain |
| Two developers, one person on call, Docker Compose/systemd/cron, no Kubernetes experience | `team.md` | Rules out new infrastructure that needs operating |
| Provider limit of 10 SMS/s, and a repeated request is a new billed message | `sms-provider.md` | **No idempotency, so exactly-once delivery isn't possible** |
| Deliveries arrive in batches of 200–300 within minutes | `feature-brief.md` | At the 5 SMS/s default, 300 SMS take about 60 seconds, which is acceptable |

**Problems in the current code**
- **Duplicate SMS:** a timeout or crash after the provider accepts a message leaves the parcel unnotified, so it is sent again (`app/src/worker.js:28-33`).
- **SMS client:** there is no request timeout, and it ignores `Retry-After` (`app/src/sms.js:31-41`).
- **Stuck returns:** `markReturned` runs before `requestReturn`, so a courier error leaves a parcel marked returned with no courier request. It also aborts the rest of the run, and nothing retries that parcel (`app/bin/expire-parcels.js:13-16`).
- **Pickup race:** pickup reads and then updates without a status check, so it can overwrite a return (`app/src/parcels.js:61-66`).
- **Missing data:** the parcel has no cell field, despite `compliance.md`, and no sender contact details. Nothing can yet show a cell as free or show the sender a status.
- **Outdated docs:** `ARCHITECTURE.md` says a 30-second poll and 4-digit codes, but the code has 10 seconds and 6 digits. I treated the code as correct.

## Decision

**Keep PostgreSQL as the only source of state and the existing `worker` as the only sender, with no new services.**

**1. Timers are database rows.** All of a parcel's actions are inserted in the same transaction as the parcel:

```sql
scheduled_actions (
  id, parcel_id,
  kind,            -- sms_arrival | sms_reminder_24h | sms_reminder_48h | return_parcel | courier_return
  due_at timestamptz, next_attempt_at timestamptz,
  state,           -- pending | in_flight | done | in_doubt | failed | cancelled
  attempts, provider_message_id, last_error,
  UNIQUE (parcel_id, kind)
)
-- plus a partial index on next_attempt_at WHERE state = 'pending'
```

The table holds no phone numbers, codes or SMS text. The text is built at send time, so phone numbers stay in `parcels` alone.

**2. The worker runs two independent loops in one process.** A slow SMS queue then can't delay a return.
- **SMS loop:** handles arrivals first, then reminders, so the 08:00 backlog doesn't delay codes.
- **Returns loop:** handles the return status change and then the courier request.

**3. SMS rows are claimed one at a time.**
- The worker commits `in_flight`, releases the connection, calls the provider, then commits the result.
- A crash therefore leaves at most one SMS in doubt. Claiming a batch of 50 would leave up to 50.
- No connection is held during the HTTP call, which keeps the invariant tested in `app/test/worker.test.js:17`.
- `FOR UPDATE SKIP LOCKED` protects against an accidental second worker, and the pacing limit stays in one process.

**4. Timing rules**
- The 24, 48 and 72 hours count from `arrivedAt`, as absolute time in `timestamptz`.
- Quiet hours are checked immediately before each send, using `Europe/Kyiv` explicitly. A blocked row moves to the next 08:00.
- The last send is at 20:55, a margin I chose to allow for provider delay.
- A reminder is sent only if the parcel is still `waiting`, the arrival SMS has gone out, and at least 12 hours have passed since it did.

**5. State changes are conditional.**
- Return runs `UPDATE parcels … WHERE status = 'waiting'`, cancels pending SMS and adds the `courier_return` row and an event in one transaction. The courier is called afterwards, with retries.
- Pickup uses the same check and also cancels pending actions.

**6. Failure behaviour**

| Situation | Behaviour |
|---|---|
| 429 or a connection failure before the request is sent | Not sent, so retry safely, honouring `Retry-After` |
| Permanent 4xx | `failed`, and alert |
| Timeout, 5xx, or crash leaving `in_flight` | `in_doubt`, handled by kind (below) |
| In-doubt arrival SMS | Resend after 5 minutes with an agreed "repeat message" wording, up to 3 times, then alert |
| In-doubt reminder | Never resend, because losing one is harmless |
| In-doubt courier request | Retry with the same `parcel_id` |
| Five ambiguous results in a row | Pause sending and alert, rather than working through the queue |
| Backup window | The claim is a write, so it fails before any external call; log a warning with a short `lock_timeout` and try again later |
| Result can't be saved | Retry the commit from memory; if the process dies first, the row becomes `in_doubt` |
| Deploy or SIGTERM | Stop claiming and finish the current send; `stop_grace_period` must exceed the SMS timeout (about 10 seconds) |

**7. Monitoring.** Keep `/health` free of database calls, as its test requires, and add a separate endpoint that returns counts only.
- **Alert on:** overdue actions by `next_attempt_at` (held rows don't count), `in_doubt`/`failed` rows, and worker heartbeat.
- **Return alerts:** need a threshold above 30 minutes so the backup doesn't trigger them.
- **Content:** logs and alerts contain `parcel_id` only.

**8. Rollout, following the brief's priorities**
1. Add the table and move arrival SMS onto it, with quiet hours and SMS client fixes.
2. Add the 24-hour reminder.
3. Add the exact return, removing the 03:15 cron job in the same release so returns aren't requested twice.
4. Add the 48-hour reminder, which is just one more row kind and the first thing to cut.

Backfill must not send overdue reminders for parcels already waiting.

### Alternatives considered

| | **A. PostgreSQL table (chosen)** | **B. Redis + BullMQ on the VM** | **C. Managed cloud queue and scheduler in an EU region** | **D. Cron every minute** |
|---|---|---|---|---|
| New monthly cost | €0 | €0 | Small, but a new line to justify in grant reports | €0 |
| Atomic with parcel insert | Yes | No, needs an outbox anyway | No, needs an outbox anyway | Yes |
| Backup and restore | Already covered | Second store to back up and keep consistent | Queue state sits outside the backup | Already covered |
| Phone numbers | Remain in `parcels` | Must be kept out of jobs | Must be kept out of messages, and the vendor needs a DPO review | Remain in `parcels` |
| Operations | Nothing new | New service sharing 4 GB of RAM, for one on-call person | New skills, IAM, and network access to the database | Nothing new, but overlapping runs |
| Timing | About 10 seconds | Seconds | Seconds | Up to 60 seconds, plus container start |
| Main drawback | We write and own the queue logic | Two sources of truth | Most moving parts for this load | Separate processes break the shared rate limit |

- **B and C:** their main benefit is scale we don't need, and neither solves the real problem, because a queue can't make a non-idempotent provider exactly-once.
- **D:** it's the smallest change, but fixes for rate limiting and in-doubt handling would have to be rebuilt around it.
- **`pg-boss`:** a reasonable fallback if our own queue code grows, but quiet hours and in-doubt rules would still be ours to write.
- **In-memory `setTimeout`:** timers disappear on restart, which is the failure we're trying to fix.

## Consequences

**Benefits**
- Timers survive restarts, and a crash affects at most one SMS.
- Infrastructure stays at about €5 of the €60 limit, with no new place for phone numbers to live.
- Returns no longer get stuck after a courier error, and a pickup can't overwrite a return.

**Limits to tell the coordinator directly**
- **"Never lost and never twice" can't be fully guaranteed.** In the rare in-doubt case we choose a possible duplicate, labelled as a repeat, because a lost code costs a person their parcel.
- **"As soon as it arrives" won't always hold.** A parcel placed at 21:30 gets its code at 08:00, leaving about 61 of the 72 hours.
- **"Exactly 72 hours" means within about 10 seconds, except during the backup.** A return due at 02:00–02:30 runs when the window ends.
- **The cell isn't physically free at 72 hours.** The code stops working and the courier is requested, but the cell stays occupied until the courier arrives, and we have no courier service-level terms.
- **A long SMS outage can return a parcel before anyone was told.** That triggers an alert, but the return still goes ahead, because extending storage is out of scope.
- **Accepted by the provider doesn't mean delivered.** Catching carrier failures needs the delivery webhook, as a later step. We store the message `id` now to allow it.

**Costs and new work**
- We own the queue code, its tests, and cleanup of finished rows.
- SMS spend rises to at most €0.105 per uncollected parcel (3 × €0.035), so the communications budget owner needs to know. Texts over 70 characters may cost more.
- The Postgres adapter needs real transactions; the current interface exposes only single operations.

**Backup runbook change (required):** restoring a dump brings back rows as `pending` even if they were sent after the dump, which would resend codes on a large scale. Before the worker restarts, a script must cancel overdue reminders and mark overdue arrivals `in_doubt`. Parcels registered after the dump are still lost, as they are today.

## Assumptions

1. The production Postgres adapter and `deploy/` weren't in this folder. I assume Postgres supports `SKIP LOCKED`, and that production runs a single worker at about 5 SMS/s.
2. **Reminders don't include the code.** This follows the "no same code twice" rule and the lawyer's approved wording, "Ваша посилка чекає у поштоматі". Someone who deleted the first SMS can't recover the code, because the admin view hides it. Changing this is a one-line template edit.
3. The 72 hours run from `arrivedAt`, not from the first SMS.
4. The courier API accepts requests at night and handles a repeated `parcel_id` safely. If it doesn't, an in-doubt retry could cause a second collection.
5. "Sender sees the status" means through the delivery service, using a new status endpoint and the courier request, since we hold no sender contact details.

## To confirm before implementation

| Owner | Question |
|---|---|
| Data protection officer | Are the SMS provider, backup storage, free monitoring tier and alert channel all EU-based? The materials don't say, and the phone-number rule covers the first three. Alerts will carry no phone numbers either way. |
| Iryna + courier company | How quickly is a parcel collected after a request, and is `parcel_id` handled idempotently? This decides how much the feature actually frees cells. |
| Iryna | Should reminders include the code (assumption 2), and how does the sender see the status? |
| Communications team + Olena | Final wording for the reminder and repeat SMS, within 70 characters. |
| SMS provider | Webhook payload format, and whether it can be matched to a message when the `id` was never received. |
| Andriy | Update the backup runbook, and add the cell field if `compliance.md` is right that it should be stored. |
