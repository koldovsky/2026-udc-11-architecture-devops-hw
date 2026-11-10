- Інструмент і модель: Claude Code, Claude Opus 5.5
- Дата: 2026-11-04
- Що бачила сесія: тимчасова тека `ws11-a-without` з копією `app/`. Примітка: промпт пішов
  з незаповненим плейсхолдером, тож сесія вийшла за межі теки й прочитала
  `materials/feature-brief.md` — це не чистий прогін «без матеріалів» (див.
  `docs/constraints.md`, «Застереження щодо прогонів»).
- Промпт (дослівно, плейсхолдер `<три пункти…>` так і лишився незаповненим):

  > У цій теці — код сервісу «Поштомат громади» (app/). Ми додаємо нову функцію:
  > <три пункти з розділу «Що хочемо», своїми словами>.
  > Запропонуй архітектурне рішення і оформи його як ADR у форматі Nygard
  > (Context, Decision, Consequences) з щонайменше двома альтернативами та їхніми компромісами.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

# ADR-001: Durable parcel task queue in PostgreSQL for SMS and returns

**Status:** Proposed (2026-11-04)

## Context

**Requirements, in priority order:**
1. Send an arrival SMS with the locker number and code as soon as a parcel is placed.
2. Send reminders at 24 h and 48 h if the parcel hasn't been collected. The 48 h reminder can be cut.
3. Return the parcel to the sender at exactly 72 h, instead of the next night. The cell is freed and the sender sees the status.

The coordinator also requires that a code isn't lost if a process crashes, and that nobody gets the same code twice.

**Current code that affects the decision:**

| Location | Problem | Effect |
|---|---|---|
| `src/worker.js:28-33` | The SMS is sent first and `notifiedAt` is saved afterwards, with no claim on the row | A crash or failed save causes a duplicate, and so does running two workers |
| `src/sms.js:31-43` | No timeout or idempotency key, and a failed `res.json()` after a 200 counts as a failure | A send can hang forever, or an accepted SMS can be sent again |
| `src/worker.js:24,31` | Failed rows are retried immediately with no backoff or attempt limit | 50 permanently failing rows could block the whole queue |
| `src/worker.js:58-67` | A batch takes at least 10 s at 5 SMS/s, then the loop can sleep another 10 s | Docker's default 10 s stop grace period would likely kill it mid-batch |
| `bin/expire-parcels.js:14-15` | The parcel is marked returned before the courier is called, and the first error stops the loop | A parcel can be "returned" with no courier ever requested |
| `src/parcels.js:61-65` | Pickup reads and then updates without a condition | A daytime return can race a resident standing at the locker |
| `src/parcels.js:80` | Expiry loads all parcels and filters them in memory | This is too expensive to run every few seconds |

**Gaps in the system:**
- **Cells:** there is no cell model, only `lockerId`, and no courier confirmation of collection.
- **Sender status:** `sender` is free text, and the only list endpoint is staff-only.

**Load:** deliveries arrive in waves of 200–300 parcels, usually in the afternoon, so the 24 h, 48 h and arrival peaks can coincide. The worst case for one wave size is about 900 SMS, or 3 minutes at 5 SMS/s. That is manageable, but only if arrival messages go first.

**Assumptions:**
1. Production runs PostgreSQL on one VM with one `worker` replica, as `docs/ARCHITECTURE.md` says. The adapter and `deploy/` aren't in this folder, so I couldn't verify either.
2. Where the docs and code disagree (30 s vs 10 s polling, 4-digit vs 6-digit codes), the code is correct.
3. All timers count from `arrivedAt`, stored as an absolute timestamp, so daylight saving changes don't matter.
4. "Exactly at 72 h" means within 1 minute during normal operation.
5. The rule against duplicates means no repeat of the same message. Reminders do include the code, because people may have missed the first SMS, but the wording clearly differs.
6. Provider acceptance counts as sent, because the code shows no delivery receipts.
7. The provider's idempotency support is unknown, and so is the courier's handling of a repeated `parcel_id`.
8. There are no quiet hours, since the brief doesn't ask for them.
9. The sender sees status through a link or token given to the delivery operator.

## Decision

**Store every timed action as a row in PostgreSQL, created in the same transaction as the parcel. The existing `worker` process executes those rows.** This adds no new infrastructure.

```sql
parcel_tasks(id, parcel_id, kind, due_at, state, priority, attempts,
             lease_until, provider_ref, last_error,
             UNIQUE (parcel_id, kind))
-- kind:  arrival | reminder_24h | reminder_48h | return
-- state: pending | in_flight | done | cancelled | skipped | failed | needs_review
```

**Where timers live:** `POST /parcels` inserts four tasks due at +0, +24, +48 and +72 h. `REMINDER_HOURS=24,48` makes it possible to cut the 48 h reminder by changing configuration. SMS text is rendered at send time, so codes aren't copied into the task table or logs.

**Who sends SMS:** one worker loop claims one task per short transaction:

```sql
UPDATE parcel_tasks
SET state = 'in_flight', attempts = attempts + 1, lease_until = now() + interval '2 min'
WHERE id = (SELECT id FROM parcel_tasks
            WHERE kind <> 'return' AND state = 'pending' AND due_at <= now()
            ORDER BY priority, due_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

- **Sequence:** claim and commit, call the provider with no connection held, then record the result.
- **Crash exposure:** at most one SMS is in flight, so a crash leaves at most one uncertain message.
- **Priority:** arrival tasks go first, so reminders can't delay a code.
- **Shutdown:** on SIGTERM the worker finishes the current send and exits immediately, including from its sleep.

**Returns:** a separate loop in the same process polls every 5 s, so SMS throttling can't delay it.
1. At 72 h it runs `UPDATE parcels SET status = 'return_requested' WHERE id = $1 AND status = 'waiting'`.
2. It then calls `courier.requestReturn`, retrying with backoff. A courier outage therefore doesn't delay the status change.
3. The `parcels.status` column is the only source of truth, so a late-running worker doesn't block a pickup.

**Pickup:** this becomes one transaction, a conditional `UPDATE … WHERE status = 'waiting' RETURNING` that also cancels pending tasks. This needs a new `withTransaction` in `src/db.js` and in the production adapter, plus a partial unique index on `code` for waiting parcels.

**Stale reminders:** a reminder is skipped if the next stage is already due, or if the arrival SMS went out less than 6 h ago (a value I chose). This stops an outage from producing a burst of messages.

**What happens on failures:**

| Failure | Behaviour |
|---|---|
| Provider gives a clear 429 or connection refused | Retry with backoff up to 15 min, by moving `due_at` forward |
| Provider returns 400 (bad number) | Mark `failed` and alert staff; the return still runs at 72 h |
| Timeout, 5xx, or crash during a send | **Outcome unknown:** handled as below |
| Worker down for hours | Tasks wait safely and run on restart, arrivals first |
| Courier down | Status changes on time and the courier call retries |
| Resident picks up just after a reminder is claimed | One extra reminder at most; accepted |

**The two delivery guarantees conflict.** Without provider support, nobody can tell whether a request that timed out was delivered, so "never lost" and "never twice" can't both be absolute. So:
- **If the provider supports an idempotency key:** send `parcel-{id}-{kind}` and retry safely. This is what actually delivers both guarantees.
- **If it doesn't, arrival SMS:** resend once, then mark `needs_review` and alert staff. A lost code is worse than a duplicate, and the 24 h reminder is a backstop.
- **If it doesn't, reminders:** don't resend, because a duplicate is worse than a missed reminder.

**Sender status:** `POST /parcels` also returns an unguessable `trackingToken`. A new `GET /parcels/status/{token}` returns only the status, with no phone number or code. Parcel IDs are sequential, so they can't serve as the lookup key.

**Rollout:**
1. Stop the worker and remove the nightly cron job, otherwise both mechanisms could return parcels.
2. Migrate the schema and deploy the API and worker.
3. Run an idempotent backfill: reminders already past due become `skipped`, and `return` tasks are created for parcels still waiting.

`notifiedAt` keeps being written, so a rollback won't resend arrival messages.

### Alternatives considered

| Option | Advantages | Disadvantages | Verdict |
|---|---|---|---|
| **A. Task table in PostgreSQL** | Atomic with parcel data, survives restarts, no new dependencies, keeps per-message history | Needs polling, leases and a migration; PostgreSQL remains a single point of failure | **Chosen** |
| **B. Timestamp columns on `parcels`** (`reminder24_sent_at`, etc.) | Smallest schema change, simple queries | Attempts, lease and error state must be repeated for each stage; the table gets wider, and each new stage needs a migration | Rejected, though viable if the scope shrinks |
| **C. Run the cron scripts every minute** | Very little new code | Runs can overlap, nothing claims rows, and retries and in-flight tracking are still missing, so duplicates remain | Rejected |
| **D. Broker with delayed delivery** (RabbitMQ or Redis/BullMQ) | Ready-made retries and delays, scales further | Another stateful service on one VM, and the service currently has zero dependencies. Writing to both the database and broker still needs an outbox. Unjustified at 5 SMS/s | Rejected |
| **E. In-process `setTimeout`** | Trivial to write | All timers vanish on restart, which is the incident the brief describes | Rejected |

## Consequences

**Benefits**
- Timers survive crashes and restarts, and the 72 h delay falls from 3–4 days to about a minute.
- Failing messages back off, so they can't block the queue.
- Deploys and restarts no longer interrupt a batch.
- Each message has an auditable state, which helps the hotline answer questions.

**Costs and risks**
- **The cell is not physically free at 72 h:** at that moment the code stops working and the courier is asked to collect. The cell stays occupied until the courier arrives, so the courier's response time decides how much the hotline's cell problem improves.
- **A resident can arrive after 72 h and find the parcel still there:** the code is rejected, as the brief's "exactly at 72 h" implies.
- **SMS costs rise:** there can be up to 3 messages per parcel. Cyrillic SMS segments hold about 70 characters, so long reminder text could double the cost of each message.
- **Dependency on approved text:** reminders can't launch until the communications team approves the wording.
- **Single VM remains:** if it goes down, tasks are delayed but survive only if the database does. Backups aren't visible in this folder.
- **Monitoring is needed:** `/health` deliberately doesn't touch the database, and a test enforces that. Add a separate alert for overdue tasks older than 5 minutes and for `failed` or `needs_review` rows. The hotline is closed at weekends while returns continue, so someone must own these alerts.
- **One worker only:** the rate limiter lives in each process, so a second replica would double the SMS rate. `SKIP LOCKED` keeps overlapping workers safe from duplicates, but not within the rate limit.
- **Code and test changes:**
    - `test/expire.test.js` and `bin/expire-parcels.js` are replaced.
    - The `POST /parcels` response test in `test/server.test.js` changes because of the new token.
    - New tests should simulate a crash at each step using the existing injected `clock`.
    - `docs/ARCHITECTURE.md` needs updating, since it is already out of date.

**Questions to settle before implementation**

| Question | For | Why it matters |
|---|---|---|
| Does the API support an idempotency key or a lookup by client reference? | SMS provider | Decides whether the no-duplicates guarantee can be met in full |
| Does it deduplicate on `parcel_id`, how quickly does it collect, and can it confirm collection? | Courier | Decides when cells are really free, and whether a `returned` status can be set |
| Is a reminder containing the same code acceptable? | Iryna Koval and the communications team | Assumption 5 depends on it |
| How do senders actually receive status? | Iryna Koval and the delivery operator | Assumption 9 depends on it |

**Outside this decision:** `POST /parcels` and `POST /pickup` have no authentication or rate limiting, and a missing `sender` causes a 500 rather than a 400. Reminders make codes more visible but don't change these risks, so I'd track them as separate work.
