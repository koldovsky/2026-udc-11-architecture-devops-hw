# Task E (bonus) — Path 2: STRIDE threat model for ADR-0001

- **Author:** Yurii Slynko; draft by Claude Code (claude-opus-5-5)
- **Date:** 2026-11-01
- **What is modelled:** the system in `docs/architecture.md` as `docs/adr/0001-notifications.md`
  (status: proposed) changes it. "ADR NN" below means line NN of that ADR. Line numbers in
  `deploy/` and `pipeline/` refer to this branch (Task D), not to commit `c6800ab`.

Paths 1 and 3 are not done. Path 1 needs Docker, which the machine used for this homework
does not have. Path 3 would hold a single line: the ADR adds no server, service or monthly
infrastructure cost (ADR 11, ADR 188-189), and its one cost, up to three SMS per parcel, is
already in the ADR (ADR 216-218).

## 1. What are we working on?

ADR-0001 keeps today's system and adds four things: the `parcel_tasks` table in the
existing PostgreSQL (ADR 108-128), a worker loop that sends the arrival SMS and two
reminders and starts returns at 72 hours in place of the nightly job (ADR 94-95,
ADR 143-163), `GET /ops/tasks` for monitoring (ADR 434, ADR 468-475), and a resend / resolve
script the on-call engineer runs on the VM (ADR 337-346).

**Assets**

| Asset | Why it matters | Where it lives |
|---|---|---|
| Pickup code, 6 digits | Whoever has it can take the parcel out of the cell | `parcels` row (`app/src/parcels.js:27`, `app/src/parcels.js:45`); SMS text (`app/src/worker.js:11-13`); with the ADR, up to three SMS per parcel (ADR 130-141) |
| Recipient phone number | Personal data that must stay in the EU in every store, queue, log and service (`materials/compliance.md:11-13`) | `parcels` row; every request to the SMS provider; nightly dumps |
| `SMS_TOKEN` | Sends SMS under the sender name `POSHTOMAT`, paid per message (`materials/vendors/sms-provider.md:7-8`, `materials/vendors/sms-provider.md:13-14`) | `deploy/.env` on the VM (`deploy/compose.yaml:8-11`); the environment of the worker container only (`deploy/compose.yaml:51`, `deploy/compose.yaml:75-76`; row 7) |
| Parcel and task state | Decides who gets which SMS, when, and when a parcel goes back | `parcels` and, with the ADR, `parcel_tasks` (ADR 108-128) |

**Data flows.** Flows 1–11 are the arrows of `docs/architecture.md`; 12–15 are what the
ADR adds or what the diagrams leave out.

| # | Flow | Protocol and authentication | Evidence |
|---|---|---|---|
| 2 | Locker terminal → API `POST /pickup` | HTTP, none | `app/src/server.js:42-45` |
| 3 | Delivery scanner → API `POST /parcels` | HTTP, none | `app/src/server.js:38-40` |
| 4 | Community staff → API `GET /admin/parcels` | HTTP, `Bearer <session id>` | `app/src/server.js:14-19`, `app/src/server.js:47-49` |
| 5 | Monitoring → API `GET /health` | HTTP, none | `app/src/server.js:37` |
| 6, 7, 10 | API, worker, nightly job → PostgreSQL | `DATABASE_URL` without a password; how the database authenticates is set on the VM | `deploy/compose.yaml:41` |
| 8 | Worker → SMS provider | HTTPS, `Bearer SMS_TOKEN` | `app/src/sms.js:31-34`, `deploy/compose.yaml:50-51` |
| 9 | SMS provider → resident | SMS with the locker number and the code | `app/src/worker.js:11-13` |
| 11 | Nightly job, with the ADR the worker → courier returns API | HTTPS, no authentication header | `app/src/courier.js:7-9`, `deploy/compose.yaml:55` |
| 12 | Worker ↔ `parcel_tasks` (new) | as flow 7 | ADR 108-128, ADR 271-372 |
| 13 | Monitoring → API `GET /ops/tasks` (new) | HTTP, none | ADR 468-472 |
| 14 | On-call engineer → resend / resolve script on the VM (new) | SSH with keys, two developers | ADR 337-346, `materials/compliance.md:19` |
| 15 | VM → backup object storage | not in the repo | `docs/ops/backup-runbook.md:12-13`, `materials/budget.md:19` |

Flow 1 (resident → locker screen) is physical and is left out (section 4).

**Trust boundaries**

- **B1 — network ↔ API** (flows 2–5, 13). Compose publishes port 8080 straight from the
  container (`deploy/compose.yaml:63-64`); the API speaks plain HTTP (`app/src/server.js:1`,
  `app/src/server.js:93`). The budget pays for a domain and free certificates
  (`materials/budget.md:21`), so TLS probably terminates somewhere in front of the API, but
  nothing in the repo shows where.
- **B2 — VM ↔ third-party APIs** (flows 8, 11).
- **B3 — phone network ↔ resident** (flow 9). Outside the team's control.
- **B4 — people ↔ VM** (flow 14).
- **B5 — VM ↔ backup storage** (flow 15).
- **B6 — containers ↔ PostgreSQL on the VM host** (flows 6, 7, 10, 12;
  `deploy/compose.yaml:1`).

**Assumptions** (not in the repo; a threat that rests on one names it)

- **A1.** Port 8080 can be reached from the networks the terminals and scanners use, not
  only from the VM. The ADR assumes the same for `/ops/tasks` (ADR 468-469). The lockers
  stand in five districts (`materials/feature-brief.md:43`).
- **A2.** A terminal opens a cell only for its own successful `/pickup` request. Its code
  is not in the repo (`docs/architecture.md:104-106`).
- **A3.** About 500 parcels wait at any time. The materials give only the batch size of a
  delivery, 200–300 parcels (`materials/feature-brief.md:44-45`).
- **A4.** The two developers with SSH access are trusted (`materials/compliance.md:19`).

## 2–3. What can go wrong, and what are we going to do about it?

Rows are in priority order. Column "ADR": **new** — the ADR adds the element; **amplified**
— exists today and the ADR makes it worse; **today** — exists today and the ADR does not
change it.

| # | Element or flow | STRIDE | ADR | Threat | What we do | Residual risk |
|---|---|---|---|---|---|---|
| 1 | Flow 2: terminal → `POST /pickup` (B1) | S | today | Anyone who reaches port 8080 (A1) can act as a locker terminal: `/pickup` needs no authentication (`app/src/server.js:42-45`), nothing limits the rate, and 200 versus 404 tells whether a guessed code exists (`app/src/server.js:45`, `app/src/parcels.js:68`). The code is not tied to a locker: the lookup searches every waiting parcel (`app/src/parcels.js:61`, `app/src/db.js:28-29`). A random 6-digit guess (`app/src/parcels.js:60`) hits with probability W / 1,000,000 for W waiting parcels; at W = 500 (A3) that is one hit per 2,000 guesses, about 40 s for one client sending 50 requests/s. A remote hit does not open the cell (A2) but marks the parcel `picked_up` (`app/src/parcels.js:64-66`): the resident's code then gets "unknown or already used code" (`app/src/server.js:45`), and the parcel is never returned, because returns take only waiting parcels (`app/src/parcels.js:81`). The ADR does not close this: its pickup transaction also cancels the reminders and the return (ADR 121-128), and its checks watch only waiting and returning parcels (ADR 436-459), so the parcel stays in the cell with no SMS, no return and no alert. Codes come from `Math.random` (`app/src/parcels.js:24`, `app/src/parcels.js:27`), which is not a cryptographic generator. | Each terminal gets its own credential, sent with every `/pickup` and checked by the API. The API takes the locker from that credential and matches code, locker and `status = 'waiting'` together. After 5 wrong codes in a minute a terminal gets `429` for a minute (numbers to be tuned on real traffic). Codes come from `crypto.randomInt`. This needs a change in the terminal software, which is not in this repo; until then, row 4 limits who can reach the port. | High until terminals authenticate; then low: guessing only at a screen, at typing speed, under a per-terminal limit |
| 2 | Flow 3: scanner → `POST /parcels` (B1) | S, D | amplified | Anyone who reaches port 8080 (A1) can act as the delivery scanner: no authentication (`app/src/server.js:38-40`); `lockerId` may be any positive integer (`app/src/parcels.js:36`) although there are 12 lockers (`materials/feature-brief.md:43`), and the phone any `+` and 10–15 digits (`app/src/parcels.js:39`). Each fake parcel is a paid SMS under `POSHTOMAT` to a number the caller chooses. With the ADR it is up to three SMS, 0.105 EUR (ADR 216-218), plus a return request to the courier at 72 hours for a parcel that does not exist (ADR 110-111, ADR 121). 10,000 fake parcels cost about 1,050 EUR of the communications budget (`materials/budget.md:24-25`), and at 5 SMS/s (ADR 153) their arrival SMS take about 33 minutes, delaying real arrivals queued behind them. A caller can also register parcels to its own number and collect a run of codes; `Math.random` is not a cryptographic generator (row 1), so such a run may help predict the next codes (an assumption, not tested; `crypto.randomInt` in row 1 closes it). | Each delivery service's scanner gets its own credential, checked by the API. `lockerId` is checked against the list of lockers. `/ops/tasks` turns red when the SMS sent today pass a daily ceiling (for example twice a usual day). Ask the provider for a monthly spending cap on the account. The scanner change is outside this repo. | Medium until scanners authenticate; then low |
| 3 | Flows 2, 3, 4 (B1) | I, T | today | The API speaks plain HTTP (`app/src/server.js:1`, `app/src/server.js:93`) and compose publishes 8080 from the container (`deploy/compose.yaml:63-64`). Codes (flow 2), phone numbers (flow 3, `app/src/parcels.js:35`) and staff session ids (flow 4, `app/src/server.js:16`) can be read or changed on the way unless something in front terminates TLS. A TLS terminator probably exists (B1), but it is not in the repo, and port 8080 stays reachable beside it unless the provider's firewall or a `DOCKER-USER` rule closes it: Docker publishes container ports through its own iptables chains, so ufw on the VM does not filter them. | Confirm on the VM where TLS terminates. Publish 8080 only to it (for example `"127.0.0.1:8080:8080"` if it runs on the VM itself), so plain HTTP cannot be reached from outside. Describe the terminator in `deploy/`, so the repo shows it. | Unknown today; low once confirmed |
| 4 | API port (B1) | D | today | Every `/pickup` with a well-formed 6-digit code (`app/src/parcels.js:60`) and every valid `/parcels` (`app/src/parcels.js:36-42`) takes a connection from a pool of 20 (`deploy/compose.yaml:42`, `app/src/parcels.js:43`, `app/src/parcels.js:61`); a caller that waits over 2 s gets `503` (`deploy/compose.yaml:43`, `app/src/db.js:61-62`, `app/src/server.js:65`). A flood from anywhere makes the terminals answer "service busy", and residents cannot collect parcels. The ADR's `/ops/tasks` is not a way in: one cached read every 5 s (ADR 470-472). | At the TLS terminator (row 3): a per-source request limit, and `/pickup` and `/parcels` allowed only from the terminals' and scanners' addresses if those are fixed. | Medium; low with an address allowlist |
| 5 | API port (B1) | D | today | `readJson` collects the whole request body into one string, with no size limit (`app/src/server.js:22-25`), on both `POST` routes and before anything checks the request or takes a pool connection (`app/src/server.js:39`, `app/src/server.js:43`). A `/pickup` with a 20 MB body is read to the end and answered `404` (the command under "How it was checked"). A few such requests in parallel from anywhere (A1) can use up the API's 512 MB (`deploy/compose.yaml:68`): the process dies, compose restarts it (`deploy/compose.yaml:17`), and the terminals get errors meanwhile. The pool of row 4 does not limit this, because the body is read first. | `readJson` stops at a size limit, for example 16 KB, far above any real `/pickup` or `/parcels` body, and answers `413`; a change in `app/` with a test. The TLS terminator (row 3) applies the same limit, so a large body does not reach the API. | Medium until the limit is in place; then low |
| 6 | Flows 2, 3 (B1) | R, D | today | Anyone who reaches port 8080 (A1) can make the API answer `500` at will. A `/pickup` body of `null` fails at `const { code } = …` (`app/src/server.js:43`); a `/parcels` body with a valid `lockerId` and phone but no `sender` fails at `sender.trim()` (`app/src/parcels.js:42`). Both end as `500` (`app/src/server.js:68`), and every `5xx` is logged, while other answers are logged one in 100 (`app/src/server.js:74-75`). A `request failed` line takes about 200 bytes (195 for the first one in `incident/logs/api-2026-10-14.jsonl`), so at most about 250,000 such requests fill the 5 × 10 MB of logs compose keeps (`deploy/compose.yaml:29-33`) and rotate out every earlier line, the traces of code guessing (row 1) included. The same flood lifts `error_rate` above 0.05, and after 3 minutes `Api5xxRateHigh` calls the one on-call person (`incident/alerts.json:23-28`, `materials/team.md:12-13`), at any hour. | Requests the API cannot use get `400`, not `500`: the body must be a JSON object, and `sender` a non-empty string; a change in `app/` with a test per case. The per-source limit of row 4 caps what is left. | Medium until the change; then low. A flood that exhausts the pool still answers `503` and pages (row 4) |
| 7 | API container (B1) | E, I, S | today | The API is the one container that faces the network. Until this fix it also got `SMS_TOKEN`, `SMS_BASE_URL`, `SMS_RATE_PER_SEC` and `COURIER_BASE_URL` (`c6800ab:deploy/compose.yaml:18-21`, the same through the shared `x-env` before the fix) but never used them: only the worker creates an SMS client (`app/src/worker.js:44`), and only the nightly job, with the ADR the worker, a courier client (`app/bin/expire-parcels.js:26`). A bug that lets a caller run code in the API or read its environment would give the power to send SMS as `POSHTOMAT` at the community's cost. The rest is in place since Task D: non-root user (`deploy/Dockerfile:20`), read-only root filesystem, no capabilities, `no-new-privileges`, a process limit (`deploy/compose.yaml:19-28`). | Done: `x-env` holds only what both services need (`deploy/compose.yaml:38-43`); the four variables are in `x-worker-env` (`deploy/compose.yaml:48-55`), which only `worker` takes (`deploy/compose.yaml:76`), while `api` takes `x-env` (`deploy/compose.yaml:66`). `NOT_NEEDED` lists the four for `api` (`tools/check-deploy.mjs:380-383`), so rule E1 does not ask for them there and still checks everything else; a test in `tools/test/compose-env.test.mjs` covers it. E1 does not fail when a service sets a variable it does not need (`tools/check-deploy.mjs:710` only stops it asking): the v1.7.3 compose, the configuration that ran before the incident, gives them to `api` and must stay a PASS, so keeping them out of `api` rests on review. | Low |
| 8 | Flow 9: SMS → resident (B3) | S | amplified | Someone sends SMS that look like ours, with a link or a payment request. Residents already took a duplicate SMS for fraud (`materials/feature-brief.md:33-34`). With the ADR three SMS per parcel become normal, so one more "reminder" does not stand out. The phone network does not authenticate sender names; nothing in this system can stop such an SMS. | Our texts never contain a link and never ask for payment or data (payment at pickup is out of scope: `materials/feature-brief.md:52`). The community site says so next to the data-processing notice (`materials/compliance.md:17`). The communications team checks every new text against this rule when it approves the texts (`materials/feature-brief.md:37`). | Medium, outside our control |
| 9 | Flow 9: SMS → resident (B3) | I | new | Under the ADR's reading of constraint 6 the reminders repeat the code (ADR 130-141), so the code sits on the phone three times, in lock-screen previews and on shared phones. A wrong number entered at the scanner (any `+` and 10–15 digits pass, `app/src/parcels.js:39`) sends the code to a stranger three times instead of once. | Part of the coordinator's sign-off the ADR already asks for (ADR 232-233): if the reading is rejected, the reminders drop the code. Either way a pickup cancels the remaining reminders (ADR 121-128). | Low; accepted only with the sign-off |
| 10 | Flow 11: → courier returns API (B2) | S, R | today | Our return requests carry no authentication header (`app/src/courier.js:7-9`), so the courier cannot tell them from anyone else's. Parcel ids are a counter in this repo's store (`app/src/db.js:15`, `app/src/db.js:21`); if production ids are sequential too, anyone can request returns of our parcels, and the courier collects parcels whose residents are on their way. The courier's answer is not kept (`app/bin/expire-parcels.js:15`), so a disputed return has no courier reference on our side. | Ask the courier for an API key or signed requests and keep the key in `deploy/.env` next to `SMS_TOKEN`; add it to the ADR's open question on the courier API (ADR 234-235). Store the courier's reference in the `return` row, as the ADR does for SMS with `provider_msg_id` (ADR 118). | Medium, depends on the courier |
| 11 | Flows 6, 7, 10, 12 → PostgreSQL (B6) | T, I | amplified | `DATABASE_URL` carries no password (`deploy/compose.yaml:41`), and no other variable in compose holds one (`deploy/compose.yaml:38-55`). PostgreSQL runs on the VM itself (`deploy/compose.yaml:1`, `docs/ops/backup-runbook.md:7`) and the containers reach it at 192.0.2.10 (`deploy/compose.yaml:41`), so it listens beyond loopback; how it authenticates the containers is set on the VM, and the production database code is not in the repo (`app/src/db.js:1-2`). Whoever can write the database can change a phone number and receive the code. With the ADR the database also decides who gets an SMS and when a parcel goes back (ADR 108-128). | Confirm on the VM that PostgreSQL accepts connections only from the Docker network and only with a password (`scram-sha-256`), and that the firewall closes 5432 from outside. Keep the password in `deploy/.env` next to `SMS_TOKEN`. | Unknown until checked; low after |
| 12 | Flows 2, 3 (B1) | R | today | The pickup event holds the parcel and the time, not who sent the code (`app/src/parcels.js:67`); a registration records nothing about its caller. Requests that are not `5xx` are logged one in 100 (`app/src/server.js:9-11`, `app/src/server.js:74-75`), so code guessing (row 1) leaves almost no trace, and "I never took my parcel" cannot be answered. | With the ADR's implementation ("What comes first", step 7), not in place today: the API counts rejected `/pickup` requests and logs the count once a minute, without codes, and `/ops/tasks` turns red on a burst. A line per rejected request would let a flood of guesses rotate the evidence out of the 5 × 10 MB of logs compose keeps (`deploy/compose.yaml:29-33`), as a flood of `500` answers can today (row 6). After rows 1 and 2: the terminal or scanner id goes into the event and the parcel row, and each rejected `/pickup` is logged with the terminal id and without the code; row 1's per-terminal limit keeps those lines few. | Low after rows 1, 2 and 6 |
| 13 | Flow 14: on-call → resend / resolve script (B4) | R | new | The ADR names the engineer only for resolve, which closes a row "with the engineer's name and a note" (ADR 343-344), kept in `resolved_by` and `resolution_note` (ADR 119). For resend it says only that the row goes back to `pending` (ADR 341-342), and both actions reach `events` "with `parcel_id` only" (ADR 346). Resend is the one case where an SMS can repeat (ADR 341-342), so who decided it matters most there, and as written nothing records it. Where a name is recorded, a name passed as an argument lets either developer enter any name. | Both actions write an `events` row with the action, the engineer and the time, still without phone numbers or codes; resolve also fills `resolved_by`. The script takes the name from the VM login (the wrapper passes `id -un` into the container), and each developer logs in with a personal account. This goes into the ADR's item for the script (ADR 512-513). | Low: two people, both trusted (A4) |
| 14 | Flow 13: monitoring → `GET /ops/tasks` (B1) | I, D | new | A public endpoint could show how many SMS are stuck, or be flooded into running counting queries. | Already in the ADR: it answers only `ok` or `problem` with the status code, reads one row by key, cached for 5 s; details only in the script on the VM (ADR 468-475). | Low |
| 15 | Flows 8, 15: phone numbers outside the VM (B2, B5) | I, T | today | The SMS provider receives every number, and its data location is not stated (ADR 239-241). Nightly dumps hold every number and code and go to object storage (`docs/ops/backup-runbook.md:12-13`, `materials/budget.md:19`); its region, its encryption and who holds its keys are not in the materials. Whoever holds the keys can read every dump or replace one before a restore. Constraint 2 requires the EU for every service a number passes through (`materials/compliance.md:11-13`). | Provider: the ADR's open question, sent to support and to dpo@example.org. Backups: check the bucket's region and encryption at rest, and that only the VM and the two developers hold its keys; give the answers to the owner of the backup runbook (`docs/ops/backup-runbook.md:3`). | Unknown until answered |
| 16 | Flow 4: staff → `GET /admin/parcels` (B1) | S | today | Sessions are issued outside this repo (`docs/architecture.md:192-195`), and the store in this repo has no expiry check (`app/src/db.js:55-57`), so a leaked session id may keep working. What it opens is small: the list has no codes and masked phone numbers (`app/src/parcels.js:71-75`), and the ADR keeps every operator action in the script on the VM, not in a web view (ADR 473-475). | Expiry where sessions are issued; TLS (row 3). | Low |

S — Spoofing, T — Tampering, R — Repudiation, I — Information disclosure,
D — Denial of service, E — Elevation of privilege.

**What comes first.** Owners from `materials/team.md:5-8`.

1. **Before the ADR moves from proposed to accepted:** rows 1 and 2 go to the coordinator,
   Iryna Koval. Both need the terminal and scanner suppliers, outside the team's code, and
   row 2 grows threefold with the ADR's reminders.
2. **Checks on the VM, no code** (Andrii): rows 3, 4, 11 and the backup half of row 15.
   Their answers can lower rows 1, 2, 5 and 6 as well: if port 8080 is reachable only from
   a private network, A1 does not hold.
3. **Two small changes in `app/`** (either developer): rows 5 and 6, in
   `app/src/server.js` and `app/src/parcels.js`, each with a test; `cd app && npm test`
   stays green. Neither waits for the ADR.
4. **Configuration:** row 7 is done in `deploy/compose.yaml`, `tools/check-deploy.mjs` and
   `tools/test/compose-env.test.mjs`; `npm run check:deploy` and `npm run test:tools` are
   green.
5. **SMS texts** (Olena, with the communications team): row 8.
6. **Questions to suppliers** (Iryna Koval): row 10 to the courier, row 15 to the SMS
   provider.
7. **With the ADR's implementation:** row 9 by the sign-off; row 13 and the first half of
   row 12 (the count of rejected codes and its alert) in the code the ADR already lists
   (ADR 478-530). The second half of row 12 follows rows 1 and 2.

## 4. Did we do a good job?

**Coverage.** Every flow and both containers were taken through all six categories. A
number is the row above; "·" means the category was considered and the code and materials
show nothing beyond the rows already listed, or the ADR handles it.

| Flow or element | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| 2 Terminal → `/pickup` | 1 | 3 | 6, 12 | 3 | 4, 5, 6 | · |
| 3 Scanner → `/parcels` | 2 | 3 | 6, 12 | 3 | 2, 4, 5, 6 | · |
| 4 Staff → `/admin/parcels` | 16 | 3 | · | 3 | 4 | · |
| 5, 13 Monitoring → `/health`, `/ops/tasks` | · | · | · | 14 | 14 | · |
| API container | 7 | · | · | 7 | 4, 5 | 7 |
| Worker container | · | 11 | 13 | · | · | · |
| 6, 7, 10, 12 → PostgreSQL | · | 11 | · | 11 | · | · |
| 8 Worker → SMS provider | 7 | · | · | 15 | 2 | · |
| 9 SMS → resident | 8 | · | · | 9 | · | · |
| 11 → courier returns API | 10 | · | 10 | · | · | · |
| 14 On-call → script | · | · | 13 | · | · | · |
| 15 VM → backup storage | · | 15 | · | 15 | · | · |

Cells marked "·" that rest on a decision rather than on an empty search: the ADR paces SMS
at half the provider's limit and treats `429` as "not sent" (ADR 304-315); it gives the SMS
and courier clients timeouts (ADR 514-519); it records `provider_msg_id` for every sent SMS
(ADR 118), which shows the provider accepted it, not that it was delivered (the delivery
webhook, option E, is deferred: ADR 90). The worker container publishes no port
(`deploy/compose.yaml:72-84`): what reaches it are database rows (row 11) and the HTTPS
answers of the SMS provider and the courier (`deploy/compose.yaml:50`,
`deploy/compose.yaml:55`). It runs with the same restrictions as the API
(`deploy/compose.yaml:73`), and a dead or stuck worker raises the ADR's heartbeat alert
(ADR 438-441).

Accepted rather than listed: `/health` returns the version to anyone
(`app/src/server.js:37`). The monitoring calls it without a session, and the version tells
an outsider only which known bugs to try.

**How it was checked.** Every row cites `file:line` or an ADR line; each reference was
printed and read against the claim, last on 2026-11-01. Rows 1, 2, 5, 6, 7 and
12 cite the code for every mechanism they describe; rows 1, 2, 5 and 6 also rest on A1, and
row 1 on A2 and A3. Rows 3, 4, 11 and 15 rest on what the repo does not show, and say so;
they become facts after the checks in "What comes first", step 2.

Rows 5 and 6 were also run against the API handler in memory, from the repo root, with
nothing installed and no file written:

```bash
node --input-type=module -e '
import http from "node:http";
import { createHandler } from "./app/src/server.js";
import { createParcels } from "./app/src/parcels.js";
import { createPool } from "./app/src/db.js";
let errors = 0;
const log = { error: () => (errors += 1), info() {}, warn() {}, debug() {} };
const parcels = createParcels({ pool: createPool({ max: 20, waitMs: 2000 }) });
const server = http.createServer(createHandler({ parcels, authenticate: async () => null, log }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const post = (path, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body }).then((r) => r.status);
console.log("pickup null:", await post("/pickup", "null"));
console.log("parcels without sender:", await post("/parcels", JSON.stringify({ lockerId: 1, recipientPhone: "+380000000001" })));
console.log("error log lines:", errors);
console.log("pickup with a 20 MB body:", await post("/pickup", JSON.stringify({ code: "x".repeat(20_000_000) })));
server.close();
'
```

```text
pickup null: 500
parcels without sender: 500
error log lines: 2
pickup with a 20 MB body: 404
```

The run shows that the 20 MB body is read to the end before the `404`; it does not reach
the 512 MB limit of row 5, and no container was started (Docker is not on this machine).

**What was left out on purpose.**

- The deploy path: GitHub, the pipeline and the deploy user, who may run Docker and
  therefore controls the VM (`pipeline/deploy.yml:9-10`). It needs its own model.
- Flow 1 and the lockers' hardware: physical attacks on a screen or a cell.
- The phone network itself (SIM swap, interception), beyond row 8.
- The two developers as attackers (A4).

**Weak spots of this model.** A1 and A3 are guesses. If port 8080 is reachable only from a
private network, rows 1–6 each drop a level; the check in row 3 settles it. W in row 1 can
be measured with one count of waiting parcels.

**When to revisit:** before the ADR is accepted; when terminals and scanners get
credentials; if the delivery-report webhook (option E) is built, because it is a new public
endpoint that must authenticate the provider (ADR 90); if a second worker is added
(ADR 249); at the annual data-protection audit, March 2027 (`materials/compliance.md:24`).
