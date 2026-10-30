# ADR-0001: Durable task table for arrival SMS, reminders and 72-hour returns

- **Status:** proposed
- **Date:** 2026-10-30
- **Author:** Yurii Slynko; draft by Claude Code (claude-sonnet-5-5), first answer in `ai-runs/adr-with.md`

## Summary for the executive committee

Every timer (arrival SMS, reminders after 24 and 48 hours, return after 72 hours) is
stored as a row in the database the service already uses, and the existing SMS worker
carries them out. No new server, service or monthly cost is added. No SMS is sent between
21:00 and 08:00; messages that fall due at night go out at 08:00. If the worker stops
half-way, no SMS is sent twice, and the messages it had not started yet go out in its next
round. When the outcome of a send is unknown, the system does not guess: the person gets
the code with the next reminder, or the on-call engineer decides. Parcels go back to the
sender within minutes of the 72-hour mark instead of the next night. Two points need the
coordinator's sign-off: reminders repeat the pickup code (see "Reading of constraint 6"),
and an SMS with an unknown outcome may reach the person only with the 24-hour reminder.
The sections up to "Constraints we knowingly do not fully meet" are enough to take the
decision; the appendix holds the mechanics for the developers.

## Context

The brief asks for three things: an arrival SMS with the locker number and pickup code,
reminders after 24 and 48 hours, and a return to the sender exactly at 72 hours
(`materials/feature-brief.md:20-25`). The code must not be lost if the process dies
mid-run, and one person must not get the same code twice
(`materials/feature-brief.md:32-35`, constraint 6 in `docs/constraints.md`). Constraint
numbers below refer to `docs/constraints.md`.

**How the system works today**

- The worker sends the SMS and only afterwards writes `notifiedAt`
  (`app/src/worker.js:28-33`). After a round with fewer than 50 sent it waits 10 s; after
  a full batch it goes again at once (`app/src/worker.js:8-9`, `app/src/worker.js:65-66`).
  A crash between the send and the write, or a failed write, makes the next round send the
  same SMS again. This explains duplicate codes. It does not explain the lost codes the
  brief also reports (`materials/feature-brief.md:32-33`): a failed send leaves the parcel
  unnotified, and the next round retries it (`app/src/worker.js:29-31`). That last
  winter's incident had this cause is an assumption; no input states the cause.
- Of the code defaults that production overrides, two matter here. Line numbers in
  `deploy/` refer to commit `c6800ab`, the configuration production runs today
  (`git show c6800ab:deploy/compose.yaml`). The worker sends at `SMS_RATE_PER_SEC=20`
  (`deploy/compose.yaml:34`), twice the provider's limit of 10/s (constraint 4), and each
  process has a pool of `DB_POOL_MAX=20` (`deploy/compose.yaml:16`,
  `deploy/compose.yaml:30`). The values 4 and 5/s in `app/src/config.js:9` and
  `app/src/config.js:13` apply only when the variables are unset.
- The SMS client has no request timeout (`app/src/sms.js:31-35`) and retries `429` with an
  exponential backoff of 400, 800 and 1600 ms that ignores `Retry-After`
  (`app/src/sms.js:36-39`). The courier client
  has no timeout either (`app/src/courier.js:7-16`).
- Returns come from a nightly job (cron at 03:15, after the backup:
  `docs/ops/backup-runbook.md:18-19`). A parcel is returned 72 to ~96 hours after arrival
  (`materials/feature-brief.md:11-12`, `app/src/parcels.js:81`).
- The job marks the parcel `returned` first and calls the courier second
  (`app/bin/expire-parcels.js:14-15`). If the courier call fails, the parcel is marked
  returned but nobody collects it, and the loop stops at the first error.
- `pickup` finds the parcel and then updates it in separate calls
  (`app/src/parcels.js:61-67`), so a pickup at the 72-hour mark can race with a return.
- The store in `app/` is an in-memory implementation (`app/src/db.js:2`); production
  runs PostgreSQL on the same VM, outside compose (`docs/ops/backup-runbook.md:7`). The
  table below is therefore designed for PostgreSQL and is not implemented in `app/`
  by this ADR.

**Forces (constraints from `docs/constraints.md`)**

- Money and people: infrastructure is capped at 60 EUR/month with ~5 used and the VM is
  prepaid (1); two developers, no Kubernetes experience, compose/systemd/cron on one VM,
  manual deploys (8); one person on call out of hours (9).
- Data: phone numbers stay in the EU in every store, queue and log (2); the admin UI
  masks numbers and never shows codes, and any new view must do the same (11).
- SMS: nothing is sent to recipients between 21:00 and 08:00 Kyiv time (3); the provider
  accepts 10 messages/s and answers `429` without sending (4); a repeated request is a
  new message and a new charge (5); text up to 70 Cyrillic characters per tariff unit
  (12); SMS is the only channel (10).
- Operations: from 02:00 to 02:30 the database refuses writes (7); a restore brings back
  a dump chosen by date and loses everything written after it (13).
- Load: deliveries arrive in batches of 200–300 parcels
  (`materials/feature-brief.md:44-45`), so reminders become due in the same batches.

## Options considered

| Option | How it works | Pros | Cons / risks | Constraints it touches |
|---|---|---|---|---|
| A. Per-step columns on `parcels` (`reminder24State`, `reminder24LeaseUntil`, …) plus more polling loops | The worker computes what is due from `arrivedAt`; each step gets its own state, lease and attempt columns | No new table or join; for three fixed steps it is the strongest alternative | Three to four columns per step (12–16 in total), a schema migration for every new step, and the claim, cancel-on-pickup and alert queries need one branch per step. It matches B only if every step gets the full set of columns | 5, 6 — met only with full per-step state; 7, 8 — fine |
| B. Task table in the existing PostgreSQL, drained by the existing worker (**chosen**) | One row per parcel and step with due time, state and lease; the worker claims due rows, sends, records the result | No new component or cost; duplicate protection and cancel-on-pickup in the same database transaction; one claim query and one state machine for all steps; auditable | New table and a one-off migration; more worker code; the worker is a single point of failure | 1, 2, 8, 9 — fine; 5, 6 — addressed; 3, 7, 13 — need explicit handling |
| C1. RabbitMQ with delayed delivery, in compose on the VM | Registration publishes delayed messages; the worker consumes them | Built-in delays and retries; no monthly cost; data stays on the Frankfurt VM | One more stateful service for two developers and one on-call person, sharing 4 GB RAM; a queued message cannot be removed on pickup, and queue and database can disagree, so every consumer re-checks the database anyway | 8, 9 — strained; 1, 2 — fine |
| C2. Managed cloud queue with delays | The same, run by a cloud provider | Nothing to operate | A monthly cost that needs an executive-committee decision, next session in March; one more service holding phone numbers, which must be in the EU; the same disagreement with the database as C1 | 1, 2 — strained |
| D. Workflow engine (Temporal or similar) | Each parcel is a long-running workflow | Reliable timers and retries out of the box | A server and an SDK outside the team's stack of compose, systemd and cron (`materials/team.md:10-12`); one more long-running service for one on-call person; its state must be kept consistent with our database | 8, 9 — strained |
| E. Delivery-report webhook to resolve `unknown` sends (an addition to B, not a replacement) | The provider reports delivery to our URL and retries for an hour (`materials/vendors/sms-provider.md:15`) | `unknown` rows could be resolved without a person | A new public inbound endpoint on the VM that must authenticate the provider; the payload carries phone numbers (2); a timed-out request has no message id, so it can be matched only by number and time | 2 — needs a check; deferred, see "When to revisit" |

## Decision

We keep timers and delivery state in PostgreSQL and let the existing worker execute them
(option B). We replace the nightly expire job with this worker. Option E is deferred.

Why B and not the others: B is the only option that adds no component, no monthly cost
and no new place holding phone numbers (1, 2), and it stays within what two developers and
one on-call person already run (8, 9). A queue (C1, C2) or a workflow engine (D) adds a
stateful service and a second source of truth that can disagree with the database, so
every consumer re-checks the database anyway; C2 also needs a budget decision that cannot
come before March. A (per-step columns) can be made as safe as B, but only with a full set
of state, lease and attempt columns for every step and one query branch per step; one
table gives the same guarantees with one claim query and one state machine. The trade-off
we accept is more worker code and a single worker as a single point of failure
(Consequences).

**Data.** A new table `parcel_tasks`:

- `parcel_id`, `kind` (`arrival`, `reminder_24`, `reminder_48`, `return`), with
  `UNIQUE (parcel_id, kind)` so each message kind exists once per parcel (5, 6);
- `due_at` = `arrivedAt` + 0 / 24 / 48 / 72 h, stored in UTC;
- `state`: `pending` → `claimed` → `sending` → `sent` | `unknown` | `failed`; `pending`
  and `claimed` rows can also become `cancelled`. `claimed` means the worker has taken the
  row and no request has started; `sending` means a request may have reached the
  provider. A person closes `unknown` and `failed` rows as `resolved`, or sends an
  `unknown` row back to `pending` (Appendix A, step 4);
- `lease_until`, `send_started_at`, `attempts`, `next_try_at`, `provider_msg_id`;
- `resolved_by`, `resolved_at`, `resolution_note` for the person's decision.

All four rows are inserted in the same transaction as the parcel. `pickup` becomes one
conditional update (`… WHERE status = 'waiting'`). In the same transaction it cancels the
parcel's `pending` and `claimed` rows and closes its `unknown` and `failed` SMS rows as
`resolved` with the note "picked up". This removes the pickup/return race, and a parcel
that has been collected leaves nothing for the on-call engineer to decide. The start of a
return does the same to the parcel's SMS rows, with the note "returned" (Appendix B): a
parcel leaves `waiting` only through these two transactions, so no SMS row stays due or
waiting for a person once the parcel can no longer be picked up.

**Reading of constraint 6.** The brief asks that a code is never lost and that the same
person never gets the same code twice (`materials/feature-brief.md:32-35`). With a
provider that cannot de-duplicate (5), both cannot hold literally once reminders exist: a
reminder either carries the code, and the person sees the code again, or it does not, and
a lost arrival SMS means a lost code. The complaint behind the rule is an identical SMS
arriving twice and looking like fraud (`materials/feature-brief.md:33-34`). We read
constraint 6 as "no SMS is sent twice": each kind (arrival, 24-hour reminder, 48-hour
reminder) goes out at most once, and the reminders are worded as reminders, so they cannot
be taken for a repeat of the arrival SMS, while still carrying the locker number and the
code. This reading needs sign-off by the project coordinator (Iryna Koval). If she rejects
it, the reminders drop the code, and an arrival SMS with an unknown outcome leaves the
person without a code until a manual resend.

**How it works, in short.** The appendix gives the details; step numbers refer to
Appendix A.

- **One worker, one loop (8, 9).** Each round the worker takes due rows: returns first,
  then SMS in the order arrival, 24 h, 48 h. It marks a row `sending` right before that
  row's request starts. A crash or a deploy in the middle of a batch therefore leaves at
  most the one request in flight with an unknown outcome; the rows it had not started go
  back to `pending` (steps 1, 5 and 7).
- **Quiet window (3).** SMS rows are taken only from 08:00 to 20:55 Kyiv time, and no SMS
  request starts at or after 20:58 (step 2).
- **Rate (4).** 5 SMS/s, half the provider's limit; a `429` means "not sent" (step 3).
- **Outcome (5, 6).** A row is retried automatically only when the message certainly did
  not go out; an unknown outcome waits for a reminder or a person, never for an automatic
  resend (step 4).
- **Return (7, 9).** The code stops working first, then the courier is called; a failed
  call waits for a person instead of being lost (Appendix B).
- **Backup and restore (7, 13).** Writes refused from 02:00 to 02:30 are retried; after a
  restore, tasks that may already have run wait for a person instead of running twice
  (Appendix C).
- **Alerts (9).** At night only what stops SMS or returns for everyone raises an alert;
  decisions on single rows wait until 08:00 (Appendix D).

**Privacy and cost (1, 2, 11, 12).** No new component and no new monthly cost: the table
lives in the existing database on the Frankfurt VM. Logs and alerts carry `parcel_id` and
counts, never the phone number or code. Constraint 2 holds end to end only if the SMS
provider, which receives every phone number, processes it in the EU; that is an open
question. A sender-facing status page is not built; the sender sees the status through
the courier system (assumption, see below). Each SMS text stays within 70 Cyrillic
characters, including the locker number and the code, so that one message is one tariff
unit; the texts are approved by the communications team (`materials/feature-brief.md:37`).

## Consequences

- **What gets better:**
  - A crash no longer repeats an SMS: the states `claimed` and `sending`, the fenced
    result write and the unique key stand between the send and the write.
  - A crash or a deploy in the middle of a batch no longer holds back the rest of the
    batch: rows the worker had not started go back to `pending` and go out in the next
    round; at most the one request in flight ends as `unknown`.
  - Returns start within about a minute of the 72-hour mark instead of 72–96 hours: they
    are claimed ahead of SMS (Appendix A, step 1), and only an SMS batch already in flight
    can delay them, by up to about eight minutes when every SMS call times out. They
    survive courier failures instead of being silently lost.
  - Pickup and return cannot both win.
  - The production send rate drops from 20/s to 5/s, below the provider's limit.
  - Infrastructure cost stays at the current ~5 EUR/month, and no new place outside the
    existing VM holds phone numbers.
- **Cost and risks we accept:**
  - Because the provider cannot de-duplicate, we choose "at most once" for unknown
    outcomes. A code waits for the 24-hour reminder or a manual resend whenever its own
    request ends without a clear answer: a timeout, a connection dropped after the
    request was sent, a `5xx`, or a crash or kill during that one request. Preferred over
    a duplicate code, which already caused calls to the hotline.
  - One more short database write per SMS (`claimed` → `sending`); at 5 SMS/s this is
    negligible, and no SMS goes out during the backup window.
  - Reminders repeat the code; this rests on the reading of constraint 6 above and is not
    yet approved.
  - Night arrivals get their SMS at 08:00, not "immediately"; arrival SMS and 24 h / 48 h
    reminders that fall due late in the evening, or are still queued at the 20:58
    cut-off, are up to about 11 hours late (20:55 → 08:00). The brief's wording yields to
    the legal rule.
  - A return can slip by up to 30 minutes during the backup window; until the courier
    confirms idempotency, a failed courier call waits for a person.
  - Every `unknown` or `failed` row waits for a person to resend or resolve it, and the
    check stays red until then; an SMS row is closed earlier if the parcel is picked up
    or its return starts.
    A row that turns `unknown` at night raises the alert only at 08:00.
  - After a restore, SMS tasks that may have gone out since the dump become `unknown`, and
    returns due before the restore wait until the courier is checked; both wait for a
    person and can delay codes and returns. Only a restore of the same night's dump that
    finishes before 08:00 skips the SMS part.
  - One worker is a single point of failure; the heartbeat alert detects it, and a second
    instance would need a shared rate limiter.
  - SMS is the only channel (10), so every reminder is a paid SMS: up to 3 × 0.035 EUR per
    parcel from the communications budget (`materials/vendors/sms-provider.md:8`,
    `materials/budget.md:24-25`).
- **What has to be done** (the steps in detail: Appendix E):
  - Data: the `parcel_tasks` table, the `return_pending` status and the `worker_status`
    row, and a one-off backfill of the existing `waiting` parcels.
  - Code: the task loop in the worker, `pickup` as one conditional update, timeouts and a
    send deadline in the SMS and courier clients, the resend / resolve script, and
    `GET /ops/tasks` for the existing monitoring. The nightly job and its cron line are
    retired.
  - Configuration: worker `SMS_RATE_PER_SEC=5` (20 today) and `stop_grace_period: 30s`.
  - Process: propose the post-restore step to the owner of `docs/ops/backup-runbook.md`;
    get the arrival and reminder texts approved by the communications team, each within
    70 characters, the reminders worded as reminders; update `app/docs/ARCHITECTURE.md`
    after the change.
- **Open questions (to confirm before accepting):**
  - Does the project coordinator accept the reading of constraint 6 (reminders repeat
    the code)?
  - Does the courier API accept a repeated request for the same `parcel_id` without
    creating a second return? Not stated in any input.
  - Does the SMS provider answer `401` / `403` before it accepts a message? Appendix A,
    step 4 retries these automatically on that assumption;
    `materials/vendors/sms-provider.md` does not say.
  - Does the SMS provider keep phone numbers in the EU? `materials/vendors/sms-provider.md`
    does not say; ask support@sms.example.net and dpo@example.org
    (`materials/compliance.md:23`).
  - What can the free monitoring tier check: only the status code, or the response body
    too? `materials/budget.md:20` names only the tier; Appendix D assumes the status code
    only.
  - "The sender sees the status" is assumed to mean the courier system and the staff
    admin; the brief does not name a sender-facing screen.
  - When does a cell count as free for a new parcel — when the courier collects the
    returned one? The code has no cell model; that needs its own decision.
- **When to revisit:** if more than one worker is needed, if the number of lockers grows
  by an order of magnitude, if the provider offers idempotency keys (then `unknown` can be
  retried safely), or if `unknown` rows become frequent enough that the delivery-report
  webhook (option E) is worth its public endpoint.

## Constraints we knowingly do not fully meet

None of the 13 constraints is dropped. Two are met only partially, and the brief's timing
is relaxed:

- Constraint 6 (code must not be lost *and* must not be duplicated): the same SMS is
  never sent twice, but the reminders repeat the code (see "Reading of constraint 6"), and
  an unknown SMS outcome can leave a code delayed until the reminder or a manual resend.
  Both trade-offs need sign-off from the project coordinator (Iryna Koval); neither is
  approved yet.
- Constraint 2 (phone numbers stay in the EU): met for everything the service runs; the
  SMS provider's data location is unconfirmed (open question).
- "Immediately" and "exactly 24/48/72 hours" hold except at night (3), during the
  02:00–02:30 backup window (7) and after a restore (13).

## Appendix — design details

### A. Worker loop

1. Claim: `UPDATE … SET state = 'claimed', lease_until = now() + interval '2 minutes'
   WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING` takes at most 50 due
   rows (50 is today's batch size: `app/src/worker.js:9`). Each round claims twice. Due
   `return` rows come first, in their own claim: the brief asks for the return exactly at
   72 hours (`materials/feature-brief.md:24-25`), and a return is not an SMS, so it is not
   paced by the SMS rate and does not queue behind SMS rows. SMS rows come second, in the
   order arrival, 24 h, 48 h. The brief ranks the features in this order for scope
   (`materials/feature-brief.md:27-28`); using the same order at run time is our reading.
   Right before each request the worker moves that one row from `claimed` to `sending`
   and sets `send_started_at`, in one short write that matches `id`, `state = 'claimed'`,
   the claim's `lease_until` and a parcel still `waiting`. If the write matches nothing,
   the row was cancelled by a pickup or the start of a return, or taken over after a lease
   expiry, and no request is made. At 5 SMS/s an SMS batch takes about 10 s, inside the lease. When every call runs
   into the 10 s timeout (step 4), a batch takes about eight minutes; one worker runs, and
   the sweep in step 5 runs only at the start of a round, so nobody reclaims its rows
   meanwhile, and the lease matters only after a crash. No connection is held during an
   HTTP call; each process has its own pool (`app/src/server.js:91`,
   `app/src/worker.js:43`).
2. Quiet window (3): SMS rows are claimed only between 08:00 and 20:55 in
   `Europe/Kyiv`. The claim alone does not keep the window: a claimed batch can run for
   minutes (step 1), and a `429` with `Retry-After` adds waits of unknown length. The
   worker therefore checks the clock again right before every send, and because the `429`
   retries run inside the SMS client (`app/src/sms.js:29-41`), out of the worker's reach,
   it passes the 20:58 cut-off to the client as a deadline for every retry: no SMS request
   starts at or after 20:58. A `claimed` row that has not started by then goes
   back to `pending` with its lease cleared and goes out at 08:00; a `429` retry that
   would start at or after 20:58 is dropped, and the row goes back to `pending` as after
   any `429`. A request started before 20:58 ends within its 10 s timeout, which leaves
   about two minutes for provider delay. Anything that falls due at night is sent at
   08:00, in priority order. The `return` task is not an SMS to the recipient and ignores
   the window.
3. Rate (4): production sends at 20/s today (`deploy/compose.yaml:34`), above the
   provider's 10/s. We pin `SMS_RATE_PER_SEC=5` for the worker: half the limit. A delivery
   of 300 parcels gets its arrival SMS in about a minute. Deliveries come mostly after
   lunch (`materials/feature-brief.md:44-45`), so the 24-hour and 48-hour reminders of the
   two previous days' deliveries can fall due in the same minutes: up to about 900 SMS,
   about three minutes at 5/s. Arrival SMS go first (step 1), so the wait falls on the
   reminders. One worker instance runs, so the pacing is global. A `429` means "not sent"
   (`materials/vendors/sms-provider.md:16-17`);
   the client waits at least `Retry-After` before the next attempt (today it ignores the
   header: `app/src/sms.js:36-39`) and starts no attempt at or after the deadline it was
   given (step 2), and a `429` left after the client's attempts sends the row back to
   `pending`.
4. Outcome (5, 6): every HTTP call gets a timeout (10 s for SMS, below the lease; today
   there is none: `app/src/sms.js:31-35`). A row goes back to `pending` automatically
   only when the message certainly did not go out. The worker maps the result:
   - `2xx` → `sent`, with `provider_msg_id`;
   - not sent, documented — `429` (`materials/vendors/sms-provider.md:16-17`) →
     `pending` with backoff;
   - not sent, at the transport level — the connection was refused, or the DNS lookup or
     the TLS handshake failed, so no request reached the provider → `pending` with
     backoff;
   - not sent, assumed — `401` / `403` → `pending` and an alert, because a bad token
     stops every message. The provider documents no meaning for these codes; we assume
     it rejects authentication before it accepts a message (open question);
   - request rejected — `400` → `failed` (terminal, alert), never retried, so it cannot
     produce a second SMS;
   - everything else — a timeout, a connection dropped after the request was sent, any
     `5xx` → `unknown`. A `502` or `504` can come from a proxy after the provider has
     accepted the message, and the provider documents "not sent" only for `429`.

   `unknown` is **not** resent automatically, because the provider cannot de-duplicate
   (`materials/vendors/sms-provider.md:18-19`) and a repeated code is the incident we must
   avoid. The reminders carry the locker number and code (see "Reading of constraint 6"),
   so a person who missed the arrival SMS still gets the code. The on-call engineer sees
   `unknown` and `failed` rows as an alert (9, Appendix D) and decides per row with a
   small script in `app/bin/`, run the way the nightly job runs today
   (`docker compose run --rm worker …`, `docs/ops/backup-runbook.md:18-19`):
   - **resend** puts an `unknown` row back to `pending` (`attempts` + 1). It is the one
     accepted case where an SMS can repeat, decided per row by a person;
   - **resolve** closes an `unknown` or `failed` row as `resolved`, with the engineer's
     name and a note, for example "number invalid".

   Both actions are written to `events` with `parcel_id` only.
5. Fencing and lease expiry: a result write matches `id`, the claim's `lease_until` and
   `state IN ('sending', 'unknown')`. At the start of every round the loop sweeps rows
   whose lease has expired. A `claimed` row goes back to `pending` with its lease cleared:
   no request was made for it, so it is safe to send. A `sending` row becomes `unknown`
   and keeps its lease value, so a slow but successful send still ends as `sent`. A row
   that is claimed again gets a new lease, so a late write from the old claim matches
   nothing. After a crash, therefore, only the row whose request was in flight can end as
   `unknown`; the rest of the batch goes out once the lease has expired, within about two
   minutes of the restart.
6. Freshness: every task checks `status = 'waiting'` when claimed and again in the
   `claimed` → `sending` write (step 1); a reminder that is overdue past the next step is
   cancelled. A parcel leaves `waiting` only through a pickup or the start of a return,
   and both cancel its `pending` and `claimed` SMS rows in the same transaction
   (Decision → Data, Appendix B), so nothing is sent after the return and no SMS row stays
   due for a parcel that can no longer be picked up. A result that would leave an
   `unknown` or `failed` SMS row for a parcel picked up or returned meanwhile is written
   as `resolved` with the note "picked up" or "returned", the same as those two
   transactions do for rows already waiting for a person.
7. Shutdown: on `SIGTERM` the loop starts no new request. The request in flight ends
   within its 10 s timeout and its result is written; a `429` at this point is not
   retried and sends the row back to `pending`. The rest of the batch, still `claimed`,
   goes back to `pending` with its lease cleared, and the process exits. The worker
   service gets `stop_grace_period: 30s` in compose: Docker's default of 10 s would kill
   it while a request that runs into its timeout is still open. If it is killed anyway,
   step 5 handles the rows as after a crash. Deploys are manual `docker compose up -d`
   (`materials/team.md:19`), so this path runs on every release.

### B. Return

`return` runs in two steps. First, one transaction moves the row from `claimed` to
`sending` (Appendix A, step 1) and the parcel from `waiting` to `return_pending`, so the
code stops working. In the same transaction, as `pickup` does (Decision → Data), it
cancels the parcel's `pending` and `claimed` SMS rows and closes its `unknown` and
`failed` SMS rows as `resolved` with the note "returned": no SMS can help a parcel whose
code no longer works, and without this step an unsent arrival row would stay due forever,
because a claim takes only rows of `waiting` parcels (Appendix A, step 6), and would keep
the overdue check in Appendix D red. Then the courier call, then
`return_pending → returned` and the row to `sent`. The cell is not released by this ADR:
the code has no cell entity
(`app/src/parcels.js:44-54` stores only `lockerId`), and the parcel stays in the cell
until the courier collects it. Until the courier confirms that a repeated `parcel_id`
creates no second return (open question), only a refused connection is retried
automatically; a timeout, a `4xx` or a `5xx` leaves the parcel in `return_pending` and its
`return` row in `unknown`, visible in the admin UI, with an alert (9, Appendix D); the
engineer checks with the courier and then resends or resolves the row with the same
script (Appendix A, step 4). The courier request already carries `parcel_id` and the
reason (`app/src/courier.js:6-14`), and the courier client gets a 10 s timeout too.

### C. Backup window and restore

Claim and result writes treat database errors as transient and retry. No SMS goes out in
02:00–02:30 because of the quiet window; the `return` task may slip until 02:30, so
returns due in the window run after that night's dump. A restore brings back a dump
chosen by date (`docs/ops/backup-runbook.md:33`; up to 14 copies are kept,
`docs/ops/backup-runbook.md:14`), and everything written after that dump is lost
(`docs/ops/backup-runbook.md:34`). Tasks carried out after the dump are `pending`,
`claimed` or `sending` again in the restored copy, so the worker would resend the same
codes and ask the courier for a second return. The restore procedure therefore gets one
step before the worker starts. It is decided by the dump's time, not by the clock at the
restore:

- SMS rows: if any time between 08:00 and 20:58 lies between the dump and the restore
  moment, every SMS task that is `pending`, `claimed` or `sending` in the restored copy
  and fell due before the restore moment becomes `unknown`. Only when the dump is from
  the same night and the restore finishes before 08:00 can no SMS have gone out since the
  dump; this part is then skipped, so night arrivals still get their SMS at 08:00.
- `return` rows: returns run at any hour, so this part always runs. Every `return` task
  that is `pending`, `claimed` or `sending` in the restored copy and fell due before the
  restore moment becomes `unknown`, and its parcel goes to `return_pending`, so the code
  does not open the cell while the engineer checks with the courier which of these
  parcels already have a return. The parcel's SMS rows are closed as at the start of a
  return (Appendix B).

The on-call engineer decides on those rows as on any other `unknown` row (Appendix A,
step 4). Parcels registered after the dump are missing from the restored copy
altogether; that limit exists today and this ADR does not change it. The new table is
added to the restore check. The runbook is an input and is not edited here; the step is
proposed to its owner (`docs/ops/backup-runbook.md:3`).

### D. Observability

Monitoring already polls the API (`app/docs/ARCHITECTURE.md:17`) on a free tier
(`materials/budget.md:20`). The materials do not say what that tier can check; we assume
it alerts only on the status code (open question), so the check below rests on the
status code alone. The worker keeps one row, `worker_status`: a heartbeat time and a flag
and a count for each condition below. It updates the row at the end of every round and,
during a long batch, at least every 30 s, so a slow provider does not look like a dead
worker. A new endpoint `GET /ops/tasks` answers `503` when one of the conditions holds.

At any hour, because each one stops SMS or returns for everyone:

- the heartbeat is older than two minutes; between 02:00 and 02:40 the limit is 40
  minutes, because writes are refused until about 02:30 and the first heartbeat after
  that comes with the next round. A backup that holds the lock past 02:40 then shows up
  as this alert. The endpoint computes this age itself, so a dead worker cannot hide it;
- the most recent SMS call was answered `401` / `403` (this clears with the next
  accepted call); left until morning, it would stop the 08:00 messages;
- a `return` task is still `pending` or `claimed` more than 45 minutes after its due time
  (the backup window allows 30): returns are not running at all. A `return` row that has
  started and ended as `unknown` is a decision on one row and counts under the rules
  below, from 08:00.

Only between 08:00 and 20:55 Kyiv time:

- an SMS task of a parcel that is still `waiting` is overdue by more than 15 minutes,
  counted from its due time or from 08:00 that day, whichever is later, so the morning
  backlog of night messages does not raise it. Rows of other parcels are closed when the
  parcel leaves `waiting` (Appendix A, step 6); the status filter keeps a row missed by
  that step from holding the check red for good;
- the last ten SMS requests in a row timed out: the provider is not answering while the
  worker is alive (this clears with the next answered request);
- a row is `unknown` or `failed`, that is, waiting for a person (Appendix A, step 4);
- a parcel stays in `return_pending` for more than an hour.

Outside that window no SMS can go out, so an overdue SMS is expected, and a decision on a
waiting row can wait until morning. Counting these at night would wake the one on-call
person (9) for nothing they need to do before 08:00; a row that turns `unknown` or
`failed` at night raises the alert at 08:00. The check clears by itself once every such
row is `resolved` or back in `pending`, so a handled row does not keep it red and a new
problem is not hidden behind an old one. Alerts go to `#poshtomat-oncall`.

The API port is published (`deploy/compose.yaml:9-10`), and like `/health` the endpoint
needs no session. It therefore answers only `ok` or `problem` with the status code, which
tells an outsider nothing more, and it runs no counting query: it reads the
`worker_status` row by its key, and the API caches that read for 5 s, so a flood of
requests costs at most one read every 5 s from the pool that `/pickup` also uses. The
counts and the rows waiting for a person are listed by the resend / resolve script
(Appendix A, step 4), which runs on the VM, where only the two developers have access
(`materials/compliance.md:19`). `/health` stays unchanged and does not touch the
database.

### E. Implementation and migration

The detailed list behind "What has to be done" in Consequences.

- **Data.** Add `parcel_tasks` (with the `claimed` and `resolved` states,
  `send_started_at` and the resolution fields), the `return_pending` status and the
  `worker_status` row (heartbeat and check flags).
- **Migration.** First stop the old worker with a long timeout
  (`docker compose stop -t 120 worker`): on `SIGTERM` it finishes its current round
  before it exits (`app/src/worker.js:52-58`), and the default 10 s could kill it between
  a send and the `notifiedAt` write. Check that it exited by itself
  (`docker compose ps -a worker` shows exit code 0, not 137); if it was killed, check the
  parcels of its last batch by hand before the backfill. Then the backfill writes the
  rows of every `waiting` parcel:
  - the arrival row is `sent` if `notifiedAt` is set and `pending` otherwise;
  - reminders already past due are `cancelled`;
  - a parcel older than 72 h gets a `return` due now, and its unsent arrival row is
    `cancelled`, not `pending`: the return starts within a minute and stops the code, so
    the SMS could not help (Appendix B).

  The backfill uses `INSERT … ON CONFLICT (parcel_id, kind) DO NOTHING`, so it runs once
  after the old worker has stopped and before the new worker starts, and again right
  after the new API is up, which covers parcels the old API registered in between; their
  arrival SMS waits for that second run. Rehearse it on a restored backup and check that
  the `pending` arrival rows equal the `waiting` parcels younger than 72 h with
  `notifiedAt` unset.
- **Worker.** Rewrite `notifyArrivals` in `app/src/worker.js` as the task loop, with the
  `claimed` → `sending` write before every request, the quiet-window check before every
  send, the 20:58 deadline passed to the SMS client (Appendix A, step 2), and the shutdown
  on `SIGTERM` (Appendix A, step 7). The start of a return also cancels and closes the
  parcel's SMS rows (Appendix B).
- **Pickup.** Make `pickup` in `app/src/parcels.js` one conditional update that also
  cancels and closes the parcel's rows (Decision → Data).
- **Nightly job.** Retire `app/bin/expire-parcels.js` and its cron line at 03:15.
- **Resend / resolve script** in `app/bin/` (Appendix A, step 4); it also lists the rows
  waiting for a person, without phone numbers or codes.
- **SMS client** (`app/src/sms.js`): a 10 s request timeout; honour `Retry-After`; take a
  deadline from the worker — 20:58 Kyiv time, or the moment of `SIGTERM` — and start no
  attempt at or after it, so a `429` whose wait would cross it ends as "not sent"; report
  which class a failure belongs to (not sent, rejected, unknown). Today the `429` retries
  run inside `send` with no such check (`app/src/sms.js:29-41`).
- **Courier client** (`app/src/courier.js`): a 10 s request timeout.
- **Compose** (`deploy/compose.yaml`, worker service): `SMS_RATE_PER_SEC=5` (20 today) and
  `stop_grace_period: 30s`. Docker's default of 10 s can kill the worker before the
  request in flight ends and its result is written (Appendix A, step 7).
- **Monitoring.** Add `GET /ops/tasks` (one read of `worker_status` by key, cached for
  5 s) and point the existing monitoring at it (Appendix D).
- **Backup runbook.** Propose the post-restore step (SMS and `return` rows, decided by the
  dump's time) to the owner of `docs/ops/backup-runbook.md`, and add the new table to the
  restore check (Appendix C).
- **SMS texts.** Get the arrival and reminder texts approved by the communications team,
  each within 70 characters, the reminders worded as reminders.
- **Documentation.** Update `app/docs/ARCHITECTURE.md` after the change.
