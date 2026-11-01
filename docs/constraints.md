# Constraints for the ADR

> Task A. Constraints found in `materials/` and `docs/ops/`, each with `file:line`.
> A constraint rules out part of the solution space or forces something to be added to
> the solution. A fact that rules nothing out is not listed (see "Considered and not
> counted" below).
> "Taken into account" means the run's decision or consequences actually weigh the
> constraint, not just restate the brief. Mentioned but contradicted by the decision
> counts as "no".
> Counting rule: a run gets "yes" when its decision or consequences weigh the constraint,
> also when it got there through an explicit assumption rather than a document; a partial
> treatment counts as "yes" when the part it handles changes the decision. Following the
> wording of the prompt is not weighing a constraint. The strict count, with guesses and
> partial treatments as "no", is given in the summary.

Run 1 — `ai-runs/adr-without.md` (sees `app/` only). Run 2 — `ai-runs/adr-with.md`
(sees `app/`, `materials/`, `docs/ops/`). Line numbers in the run columns refer to those
two files. Note: the prompt in both runs contained only the three points of the brief's
"What we want" section (`materials/feature-brief.md:20-25`), so run 1 never saw the
brief's own requirements (row 6, row 10). Those three points were given to both runs as
the question and are not counted as constraints. `c6800ab:deploy/compose.yaml:34` is line
34 of `git show c6800ab:deploy/compose.yaml`, the starting state of the homework: Task D
changes the files in `deploy/`.

## Table

| # | Constraint | Source (`file:line`) | Run 1 — without materials: taken into account? | Run 2 — with materials: taken into account? | Where in my ADR |
|---|---|---|---|---|---|
| 1 | Infrastructure budget is capped at 60 EUR/month (now ~5); exceeding it needs an executive-committee decision, next session in March. The VM (2 vCPU, 4 GB) is prepaid, so extra servers or managed services cost money | `materials/budget.md:29-31`, `materials/budget.md:10-12` | no — rejects a queue as "нова інфраструктура" (`adr-without.md:113`) but never mentions a cost or the cap | yes — "Бюджетна межа 60 € лишається недоторканою" (`adr-with.md:29`); managed queues rejected for budget (`adr-with.md:113`) | Context → Forces; Decision → "Privacy and cost"; options B vs C2/D |
| 2 | The recipient's phone number must stay inside the EU: in the database, queue, logs and any service it passes through | `materials/compliance.md:11-13` | no — no mention of data location | yes — "Всі дані лишаються у Франкфурті" (`adr-with.md:124`); flags that the SMS provider's location is not documented (`adr-with.md:145`) | Context → Forces; Decision → "Privacy and cost"; Open questions (provider location); "Constraints we knowingly do not fully meet" |
| 3 | No SMS to recipients between 21:00 and 08:00 Kyiv time (hard legal rule) | `materials/legal-notes.md:10-12` | no — contradicts it: "Тихих годин для SMS немає … навіть уночі" (`adr-without.md:63`) | yes — quiet-window claim `[08:00, 20:55)` in `Europe/Kyiv` (`adr-with.md:74`) | Decision → "How it works, in short"; Appendix A, step 2 (quiet window, checked at claim, again before every send, and as a deadline for every retry inside the SMS client); Consequences → night arrivals, late-evening rows |
| 4 | SMS provider accepts at most 10 messages/s; above that it answers `429` with `Retry-After` and the message is **not** sent. Deliveries arrive in batches of 200–300 parcels within minutes | `materials/vendors/sms-provider.md:16-17`, `materials/feature-brief.md:44-45` | no — its burst estimate at "5 SMS/с" (`adr-without.md:130`) ends with "Для «через 24 год» нормально" and changes nothing in the decision; its backoff retries (`adr-without.md:96`) are generic, not tied to `429`; the 5/s comes from the code default (`app/src/config.js:13`), the provider's 10/s and the `429` meaning are not known | yes — "ліміт 10 повідомлень/с, відповідь 429 означає «не надіслано»" (`adr-with.md:47`); pacing 5/s, `429` goes back to `pending` (`adr-with.md:75-78`) | Context → production rate 20/s; Appendix A, step 3 (rate pinned to 5/s, `Retry-After`, `429` → `pending`) |
| 5 | The provider is not idempotent: repeating a request with the same text and number is a new message and a new charge | `materials/vendors/sms-provider.md:18-19` | yes, as a guess — assumption "не гарантує ідемпотентності", SMS "принаймні раз" (`adr-without.md:60`) | yes, partly — `sending`/`unknown` states, and `unknown` is not resent automatically (`adr-with.md:79-80`); but `5xx` and "інший 4xx" count as "точно не надіслано" and are retried automatically (`adr-with.md:78`), while the provider documents "not sent" only for `429` (`materials/vendors/sms-provider.md:16-17`) | Appendix A, step 4 (automatic retry only when the message certainly did not go out: `429` as documented, a connection refused at the transport level, `401` / `403` as a stated assumption; `unknown` is never auto-resent) |
| 6 | A pickup code must not be lost if the process dies mid-run, and the same person must not get the same code twice (winter incident) | `materials/feature-brief.md:32-35` | no — accepts duplicates: "можливий рідкісний дубль" (`adr-without.md:60`), "Прийнято як меншу шкоду, ніж втрата SMS" (`adr-without.md:127`); the brief text was not in its input | yes, partly — `UNIQUE (parcel_id, kind)`, `unknown` is never auto-resent, reminders repeat the code (`adr-with.md:62`, `adr-with.md:80`); but `5xx` is retried automatically (`adr-with.md:78`), so the same code can go out twice | Decision → Data (`UNIQUE`, `claimed` / `sending`), "Reading of constraint 6"; Appendix A, steps 4, 5 and 7 (after a crash or a stop only the request in flight can end as `unknown`; rows not yet started go back to `pending`); "Constraints we knowingly do not fully meet" |
| 7 | From 02:00 to 02:30 Kyiv the database holds a write lock (`INSERT`/`UPDATE` wait or fail); reads work. The nightly expire job runs after the backup at 03:15 | `docs/ops/backup-runbook.md:10-11`, `docs/ops/backup-runbook.md:16`, `docs/ops/backup-runbook.md:18-19` | no — no mention of a backup or a write-lock window; its worker writes results at any hour | yes — dedicated section; `return` may slip up to 30 min; new table added to restore check (`adr-with.md:46`, `adr-with.md:91-93`, `adr-with.md:135`) | Appendix C (backup window and restore); Appendix D (return and heartbeat thresholds); Consequences → return may slip 30 min |
| 8 | Two developers, nobody has run Kubernetes in production; the stack is docker compose, systemd and cron on one VM; deploys are manual (`docker compose up -d`) | `materials/team.md:10-12`, `materials/team.md:19` | yes, partly — rejects an external queue as "ще один компонент для експлуатації на одній VM" (`adr-without.md:112`); the team size was not known | yes — brokers and a workflow engine rejected for the team's size (`adr-with.md:113`, `adr-with.md:116-119`) | Options table (C1, D rejected); Consequences → one worker |
| 9 | Out-of-hours on-call is one person (one week Andrii, one week Olena) | `materials/team.md:12-13` | no — failures end in an `error` log line (`adr-without.md:96`) or an unspecified alert on courier retries (`adr-without.md:97`); who receives alerts out of hours, and how much one person can absorb, is never weighed | yes — alerts "лише на дієві події" to `#poshtomat-oncall`, `unknown` left for a human decision (`adr-with.md:80`, `adr-with.md:97-100`) | Appendix A, step 4 (per-row decision, `resolved` state); Decision → Data (a pickup or the start of a return closes the parcel's rows waiting for a person); Appendix D (only what stops SMS or returns alerts at night; overdue SMS and rows waiting for a person count only 08:00–20:55; the check clears once rows are resolved); "What has to be done" and Appendix E → `GET /ops/tasks`, resend / resolve script |
| 10 | Notifications go by SMS only; no app, no push (78 % chose SMS; push is out of scope) | `materials/feature-brief.md:14-16`, `materials/feature-brief.md:51` | no — uses SMS because the prompt says "SMS про прибуття" (`adr-without.md:7`) and sends reminders by SMS too (`adr-without.md:130`); no assumption about the channel, no other channel weighed | no — SMS taken from the prompt (`adr-with.md:7`); no line weighs another channel | Context → Forces; Consequences → SMS cost (no cheaper channel for reminders) |
| 11 | Phone numbers are masked in the admin UI and pickup codes are never shown there; any new view must keep that (inferred: the line lists what is already done, `materials/compliance.md:15`; read as a rule together with the commitment on phone numbers, `materials/compliance.md:11-13`) | `materials/compliance.md:18` | no — the new sender status endpoint has no mention of masking or code exposure (`adr-without.md:98`) | yes — "Телефони в логах маскуємо (як в адмінці)" (`adr-with.md:102`) | Decision → "Privacy and cost" (logs and alerts carry `parcel_id` and counts; no new sender view); Appendix D (`/ops/tasks` answers only `ok` / `problem`; per-row details only in the script on the VM) |
| 12 | The SMS tariff is 0.035 EUR for up to 70 Cyrillic characters; a longer text is billed as more than one message | `materials/vendors/sms-provider.md:8` | no — no mention of text length or cost per SMS | yes — "Текст до 70 символів кирилицею, щоб не платити за кілька сегментів" (`adr-with.md:136`) | Decision → "Privacy and cost" (70 characters including locker number and code); Consequences → SMS cost |
| 13 | A restore brings back a nightly dump chosen by date, from up to 14 kept copies (~10 minutes for yesterday's copy); everything written after that dump is lost, including the record of SMS already sent and returns already requested (inferred from `pg_restore --clean`, `docs/ops/backup-runbook.md:34`) | `docs/ops/backup-runbook.md:30-37`, `docs/ops/backup-runbook.md:14` | no — no backup or restore in its input | no — only adds the new table to the restore check (`adr-with.md:135`); does not see that a restored dump puts already sent tasks back to "due" | Appendix C (post-restore step for SMS and `return` rows, decided by the dump's time); Consequences → after a restore |

## Summary

**Without materials:** 2 of 13 · **With materials:** 11 of 13

Rows counted "yes" for run 1: 5, 8. Row 5 is a correct guess stated as an assumption, not
knowledge from the documents. Row 8 is partial and counts because it changes the
decision: run 1 rejects an external queue as one more component to run on one VM
(`adr-without.md:112`), resting on a document it did see, one VM with docker compose
(`app/docs/ARCHITECTURE.md:27`), without the team's size or experience. Row 4 is "no":
run 1 works with the code default of 5/s, not the provider's limit, and its burst
estimate (`adr-without.md:130`) changes nothing in its decision. Rows counted "yes" for
run 2: all but 10 and 13. Rows 5 and 6 are partial: run 2 retries `5xx` automatically
(`adr-with.md:78`), so the same code can go out twice.

Strict count, with guesses and partial treatments as "no": **without materials 0 of 13 ·
with materials 9 of 13**.

Run 2 misses two rows. Row 13: restoring a backup would make its worker resend codes that
were already sent. Row 10: both runs use SMS because the prompt names it and never weigh
another channel; `grep -n -i -E 'push|застосун|e-mail|email|канал' ai-runs/adr-*.md`
finds nothing in either run.

## What the AI invented or mixed up

- Run 1 assumed no quiet hours (`adr-without.md:63`: "Тихих годин для SMS немає … навіть
  уночі") — the opposite of `materials/legal-notes.md:10-12`.
- Run 1 treated the app default `smsRatePerSec: 5` (`app/src/config.js:13`) as the
  provider's limit (`adr-without.md:52`: "з лімітом ~5 запитів/с"); the provider's real
  limit is 10 messages/s (`materials/vendors/sms-provider.md:16`). Production overrides
  the default with 20/s (`c6800ab:deploy/compose.yaml:34`), which neither run could see.
- Run 1 accepted "SMS «принаймні раз»" with possible duplicates
  (`adr-without.md:127`); the brief forbids duplicate codes
  (`materials/feature-brief.md:32-35`). The brief text was not in its input.
- Run 1 guessed non-idempotency of the provider (`adr-without.md:60`); the guess is
  right, but it is not backed by any document it saw.
- Run 1 says the pool `DB_POOL_MAX=4` is now shared by claim, finalisation and the API
  (`adr-without.md:129`). The API and the worker are separate processes, each with its
  own pool (`app/src/server.js:91`, `app/src/worker.js:43`), and production sets
  `DB_POOL_MAX=20` (`c6800ab:deploy/compose.yaml:16`, `c6800ab:deploy/compose.yaml:30`).
- Run 1 says several workers can run at once (`adr-without.md:121`). The rate pacing
  lives inside each process (`app/src/sms.js:17-25`), so N workers send at N times the
  rate.
- Run 2 treats `5xx` and "інший 4xx" as "точно не надіслано" and retries them with
  backoff (`adr-with.md:78`). The provider documents "not sent" only for `429`
  (`materials/vendors/sms-provider.md:16-17`) and is not idempotent
  (`materials/vendors/sms-provider.md:18-19`), so a `502` or `504` returned after the
  provider accepted the message becomes a second SMS with the same code and a second
  charge.
- Run 2 says "пул має лише 4 з'єднання з очіканням 2 с" (`adr-with.md:73`): the code
  default (`app/src/config.js:9-10`), the same mix-up as run 1. Production sets
  `DB_POOL_MAX=20` (`c6800ab:deploy/compose.yaml:16`, `c6800ab:deploy/compose.yaml:30`), which run 2
  could not see.
- Run 2 asserts the winter duplicates were "Найімовірніше, це причина зимового
  інциденту" (`adr-with.md:36`) — inferred from the worker code
  (`app/src/worker.js:28-33` as cited by the run); the materials do not state a cause.
- Run 2 says the provider gives no way to check delivery: "провайдер не дає способу
  перевірити факт доставки" (`adr-with.md:80`). The provider sends delivery reports by
  webhook (`materials/vendors/sms-provider.md:15`). Not resending `unknown` is still
  right, but this reason for it is false.
- Run 2 states "Всі дані лишаються у Франкфурті" (`adr-with.md:124`), while its own
  assumption 5 says the provider's data location is unknown (`adr-with.md:145`); every
  phone number goes to the provider.
- Run 2 numbers its ADR "ADR-007" (`adr-with.md:19`) and run 1 "ADR-001"
  (`adr-without.md:36`); neither number is backed by anything in the inputs.
- Run 2 relies on two unverified facts and says so: the courier API accepts a repeated
  `parcel_id` without a duplicate (`adr-with.md:144`), and the SMS provider keeps numbers
  in the EU (`adr-with.md:145`). Its claim that the sender sees the status "через
  кур'єрську систему" (`adr-with.md:89`) is also an assumption.

## Considered and not counted

Facts found in the materials that rule nothing out or only restate the brief:

- Hotline works Mon–Fri 9:00–18:00 (`materials/feature-brief.md:46-47`) — context for
  how failures get noticed, no option removed.
- The 48-hour reminder can be cut if scope must shrink (`materials/feature-brief.md:27-28`)
  — a priority, not a limit.
- SMS texts are approved by the communications team and the legal wording is agreed
  (`materials/feature-brief.md:37`, `materials/legal-notes.md:7-8`) — a process gate: it
  decides who writes and signs off the text, not what the system must do, so no option is
  removed. The 70-character tariff (row 12) is counted because it caps every message the
  design sends, and the reminders must fit the locker number and the code into it. The
  ADR still lists the approval under "What has to be done".
- Notifying the sender is "desirable, not mandatory" (`materials/legal-notes.md:16-17`)
  — optional, so nothing is forced.
- SMS are paid from the communications budget, not the IT budget
  (`materials/budget.md:24-25`) — keeps SMS cost outside the 60 EUR cap; nothing ruled
  out.
- A personal-data incident is reported to the data protection officer within a day
  (`materials/compliance.md:25-26`) — an incident process, no option removed.
- Delivery reports by webhook, retried for an hour (`materials/vendors/sms-provider.md:15`)
  — not a constraint: it forces nothing unless the design uses it. It does have design
  value: it is the only automatic way to resolve an `unknown` send, and it needs a public
  inbound endpoint. The ADR weighs it as option E and defers it.
- Provider maintenance notice three days ahead (`materials/vendors/sms-provider.md:23-24`)
  — a fact without a design impact. The 14 kept backups (`docs/ops/backup-runbook.md:14`)
  moved into row 13: a restore can bring back an older copy.
- Documentation in Ukrainian, code and comments in English (`materials/team.md:20`) — a
  convention for the team's documents, not for the system; no option removed. This ADR is
  written in English, the language chosen for the homework.
- Server access is limited to the two developers, with key-based login
  (`materials/compliance.md:19`) — it would weigh against a managed queue (C2) that
  holds phone numbers outside our server, but C2 is already rejected on constraints 1 and
  2, so the decision does not change. The ADR relies on it to keep per-row details in a
  script on the VM.
- The decision goes to the executive committee as a short document, and the brief sets no
  deadline and prefers reliable over fast (`materials/feature-brief.md:57-59`); the
  coordinator is non-technical but reads everything the team writes
  (`materials/team.md:5-6`) — a requirement on the document, not on the system. The ADR
  meets it with "Summary for the executive committee".
- Every monthly item must be explainable in the grant report, and a new item is a row
  with its tariff (`materials/budget.md:5-6`, `materials/budget.md:35-36`) — a process for
  new costs; the decision adds none, so nothing is ruled out beyond constraint 1.
- Payment on pickup, changing the locker and extending the storage time are out of scope
  (`materials/feature-brief.md:52-53`) — scope limits; the design adds none of them, and
  nothing in it needs them.
