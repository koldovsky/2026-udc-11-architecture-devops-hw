# Post-mortem: parcel lockers answer "Service busy" after release v1.8.0

> Task C. Blameless: this document is about the system and the process, not about people.
> People are named by role. Details and evidence are in [`docs/rca.md`](rca.md).

- **Date and duration:** 2026-10-14, 14:02–14:47 Europe/Kyiv, 45 minutes of user impact;
  page alerts open 14:06–14:48.
- **Impact:** residents at the lockers got "Service busy, try again later" on part of
  their pickup attempts. 3,380 API requests failed with 503, about 11 % of all requests
  in the window: 2,586 pickup attempts (attempts, including retries, not unique
  residents), 650 parcel registrations by the courier service and 144 staff list
  requests. Responses that did not fail were slow too: in the 1 % sample of them the
  median was 1.8 s and p95 3.4 s, against a p95 of about 0.25 s before the deploy; p95
  over all responses, failures included, reached almost 5 s. 135 pickups failed after more
  than 4.3 s, most likely after the parcel had already been marked picked up; faster
  failures can be of that kind too, so the exact number needs the database, and whether
  those doors opened is not yet known. Measured from the API log, which records
  every 5xx and 1 in 100 other requests (`docs/rca.md`, evidence 5, 7, 8, 14, 20).
- **How it was detected:** by the `ApiLatencyP95High` page at 14:06, 4 minutes after the
  start; the hotline reported affected lockers at 14:08.
- **Cause:** release v1.8.0 renamed the environment variable `DB_POOL_MAX` to
  `DB_POOL_SIZE` in `deploy/compose.yaml`, the service kept reading `DB_POOL_MAX` and
  silently fell back to a pool of 4 database connections instead of 20, which is too few
  for the afternoon load (`docs/rca.md`, "Root cause").

## What went well

- The page alerts fired 4–5 minutes after the start and reflected real user impact.
- The on-call engineer judged the SMS 429 warning at 13:40 correctly: messages were still
  delivered, and the warning was not the cause.
- The release author mentioned the 14:02 deploy in the incident channel on their own at
  14:13.
- The rollback took about 2 minutes and fully restored the service.
- The deploy history records every deploy, restart and rollback with time and version,
  the metrics include the pool gauges, and a normal day was available for comparison. This
  is what made the cause provable after the fact.

## What went poorly

- A configuration-only change was treated as low risk. Nothing checks that the variable
  names in `deploy/compose.yaml` match what `app/src/config.js` reads, and a missing
  variable silently becomes a development default.
- The running configuration was invisible: the startup log shows only the version, and
  `/health` answers 200 without touching the database, so health stayed green during the
  outage.
- No alert on the pool queue (`db_pool_waiting`) fired, although that metric pointed at
  the cause from the first minute. The incident data holds only the alerts that fired, so
  whether such an alert exists with a higher threshold is unknown.
- On 13.10, the only normal day in the data, the condition of the SMS 429 warning was met
  at the same minute, and API heap warnings appeared from the start of the logs on both
  days. During the incident both looked like suspects, and there was no quick way to
  compare with a normal day, so the investigation started with them.
- There was no rule to suspect the most recent deploy first. What the on-call engineer saw
  at 14:12 was the API heap at 81 % with `heap usage high` in the log, which points to a
  memory leak, and a restart is the usual first response to a leak; nothing showed the
  pool size, because the startup log has only the version. At 14:13 the release author
  described v1.8.0 as only a tidy-up of the config and the SMS text, so the deploy did not
  look related (`incident/oncall-chat.md:11-12`). A restart was tried first (it cannot fix
  a configuration problem), and the rollback was decided 39 minutes after the first page,
  "just in case".
- The release went out at 14:02, in the daily peak, with no check after the deploy that
  the service can still reach its database under load.
- The rollback procedure is not written down. Deploys are a manual `docker compose up -d`
  on the VM after a merge to `main` (`materials/team.md:19`), and nothing says that a
  rollback must restore `deploy/compose.yaml` together with the code and the image.

## Where we got lucky

- The release went out in the peak, so the fault showed within a minute and the link to
  the deploy was visible in the metrics. At noon 4 connections were almost enough (on
  both days only 6 of the 60 minutes between 12:00 and 13:00 used more than 4,
  `docs/rca.md` evidence 21), so an earlier deploy would have degraded the service
  gradually, far from the deploy time.
- The rollback, chosen without knowing the cause, restored the whole release including
  the compose file: the pool went above 4 in the first minute (`docs/rca.md` evidence
  12). A rollback of the image alone would have kept the renamed variable and changed
  nothing.
- The worker got the same pool of 4 but uses one connection at a time, so SMS delivery
  was not affected (211 SMS batches in the window vs 205 on 13.10, `docs/rca.md`, "What
  in the data is NOT the cause").

## Action items

| # | Action | Type | Owner (role) | How we verify it is done |
|---|---|---|---|---|
| 1 | In production, the service refuses to start when a setting it requires (for the API: `DATABASE_URL`, `DB_POOL_MAX`, `DB_POOL_WAIT_MS`) is missing or not a valid number, and names the variable; development defaults apply only outside production. Production is recognised by `NODE_ENV=production`, which the image already sets (`deploy/Dockerfile:9`) | prevent | service developer | a test calls `loadConfig` with `NODE_ENV=production` and no `DB_POOL_MAX` and expects an error naming it; a container started without the variable exits with a non-zero code |
| 2 | A deterministic deploy check that compares `deploy/compose.yaml` with `app/src/config.js` in both directions: every environment variable of a service is read by `config.js` or is on a short allowlist of variables the runtime uses outside `config.js` (today only `TZ`), and every variable `config.js` reads is set for `api` and `worker`, apart from variables the image itself sets with `ENV` in `deploy/Dockerfile` (`NODE_ENV`, once action item 1 makes `config.js` read it) and an explicit per-service exemption list (today only `PORT` for `worker`) | prevent | infrastructure developer (owner of `deploy/` and `tools/check-deploy.mjs`) | the rule fails on the v1.8.0 compose (`DB_POOL_SIZE` is unknown, `DB_POOL_MAX` is missing) and on a compose without `SMS_RATE_PER_SEC`, passes on the current `deploy/compose.yaml`, which sets `TZ` and has no `PORT` for `worker`, and runs in CI before every deploy (Task D) |
| 3 | The startup log line includes the effective configuration without secrets: pool size, pool wait, external hosts | detect | service developer | a test asserts that `service started` contains `db_pool_max` and `db_pool_wait_ms` and does not contain the SMS token |
| 4 | Page when `db_pool_waiting > 0` for 2 minutes in a row | detect | infrastructure developer | replaying the metrics: on 14.10 the condition holds at 14:03, so the alert fires at 14:04, two minutes before `ApiLatencyP95High`; on 13.10 never (`for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do awk -F, 'NR>1 && $6>0 {run++; if (run==2 && !f) f=substr($1,12,5)} NR>1 && $6==0 {run=0} END {print FILENAME, (f ? f : "never")}' "$f"; done`) |
| 5 | A readiness endpoint that takes a pool connection within a short timeout; monitoring and the post-deploy check use it, `/health` stays a liveness check | detect | service developer | a test with an exhausted pool: readiness answers 503 while `/health` answers 200 |
| 6 | After every deploy, a post-deploy check compares the effective configuration from the startup log (action item 3) with the expected values (`db_pool_max` 20, `db_pool_wait_ms` 2000), calls the readiness endpoint (action item 5) and for 5 minutes watches that `db_pool_waiting` stays at 0; any mismatch rolls the deploy back. It never sends `POST /pickup`: a guessed code that exists would mark a real parcel as picked up | detect | infrastructure developer | on staging, with no load, a deploy without `DB_POOL_MAX` fails the check on `db_pool_max 4` and triggers the rollback; a deploy with the correct compose passes |
| 7 | The runbook for API latency and 5xx pages starts with "deploy in the last 60 minutes → roll back first, investigate after"; every deploy and rollback is posted to `#poshtomat-oncall` automatically | mitigate | infrastructure developer | `docs/runbook.md` contains the step; the next deploy appears in the channel; a staging drill reaches the rollback within 10 minutes of the page |
| 8 | Find the pickups left half-done on 14.10: parcels with status `picked_up` and `pickedUpAt` between 14:02 and 14:47 Europe/Kyiv (11:02–11:47 UTC: the code writes `pickedUpAt` with `toISOString()`, `app/src/parcels.js:63`) without a `picked_up` event; contact those residents and fix the records | mitigate | service developer with the project coordinator | the query result is attached to the incident ticket and every row is resolved. The 135 pickups that failed after more than 4.3 s (`docs/rca.md` evidence 14) are neither an upper nor a lower bound for the number of rows, so the query, not this number, gives the count |
| 9 | Pickup uses one connection and one transaction for find, status change and event | prevent | service developer | a test where the event write fails leaves the parcel `waiting` and the code still valid |
| 10 | Replace `SmsProvider429RateHigh` with a signal that does not fire on a normal weekday, for example the age of the oldest unsent SMS | detect | infrastructure developer | on staging, SMS held back longer than the threshold fire the new alert, and in the first two weeks in production it does not fire on a day without SMS delays (the incident data has no such metric, so 13.10 cannot be replayed) |
| 11 | Write down and script the rollback: the previous release's `app/` and `deploy/compose.yaml` go back together, the image is rebuilt and the containers recreated; the script then prints the running version and `dbPoolMax` | mitigate | infrastructure developer | a staging drill: rolling back from a release with a renamed variable shows the previous version and `dbPoolMax 20` within 5 minutes; `docs/runbook.md` links the script |

Owner roles follow `materials/team.md`: two developers, one of whom also runs the
infrastructure on the VM (the infrastructure developer), and the project coordinator, who
handles requests from residents and the hotline.

- **prevent** — so that it does not happen again;
- **detect** — so that next time it is noticed earlier and more precisely;
- **mitigate** — so that when it happens, it costs less and ends sooner.

## Action item → check rule (Task D)

- **Action item:** #2
- **Rule:** `E1` in `tools/check-deploy.mjs`, "Compose environment matches what
  app/src/config.js reads". It takes the variable names `app/src/config.js` reads
  (`env.NAME`) and compares them with the `environment:` of every service in
  `deploy/compose.yaml`, in both directions, and then checks the values:
  1. every environment variable of a service is read by `config.js` or is in
     `RUNTIME_ENV`, the variables the runtime uses outside `config.js` (today only `TZ`);
  2. every variable `config.js` reads is set for `api` and `worker`, which both load the
     configuration and open a pool (`app/src/server.js:89-91`, `app/src/worker.js:41-43`),
     apart from variables the final stage of the image sets with `ENV` in
     `deploy/Dockerfile` (the container gets them without compose; `NODE_ENV` at
     `deploy/Dockerfile:9`, which `config.js` will read once action item 1 is done) and
     `NOT_NEEDED`, the per-service exemptions (today only `PORT` for `worker`: only the
     API listens on a port, `app/src/server.js:95`);
  3. no value of these variables can reach the container empty: `config.js` treats an
     empty value like a missing one (`Number("") || 4` is 4). A literal, `${VAR:?…}` and
     `${VAR:-literal}` pass; `""`, `${VAR}` without `:?` (compose substitutes a blank string
     when `VAR` is unset), a default that is only another reference (`${VAR:-${OTHER}}`) and
     a bare name (`- VAR`) fail as "may be empty".

  Every service is assumed to run the app. A service that does not (a proxy, a cache) goes
  into `NOT_APP` with its reason, and the rule skips it; the list is empty today, and a
  compose whose every service is in it is a FAIL, not a pass.

  The rule runs in CI before every deploy: the `test` job of `pipeline/deploy.yml` runs
  `npm run check:deploy`, and the `deploy` job needs it through `build`.
- **Test:** `tools/test/compose-env.test.mjs`, 12 tests on the files of the incident
  (`config.js` and the Dockerfile did not change in v1.8.0). The v1.8.0 situation
  (`DB_POOL_SIZE` instead of `DB_POOL_MAX`) → FAIL on both counts: an unknown variable and
  a missing one. The v1.7.3 compose without `SMS_RATE_PER_SEC` → FAIL: a removal, not a
  rename. The v1.7.3 compose → PASS. It sets `TZ`, which `config.js` does not read but the
  containers need for local timestamps in the logs (`app/src/log.js:2`), and the `worker`
  service correctly has no `PORT`. A naive rule "every variable in compose is read by
  `config.js`" would fail on `TZ`, and a naive rule "every variable `config.js` reads is
  set in every service" would fail on `worker`. The other tests: the `PORT` exemption
  holds for `worker` only, an image `ENV` counts only when it reaches the final stage,
  `DB_POOL_MAX: ${DB_POOL_MAX}` without `:?`, `${DB_POOL_MAX:-${POOL}}`, an empty string
  and a bare `- SMS_TOKEN` are a FAIL while `${VAR:?…}` and `${VAR:-20}` pass, a service
  that does not run the app fails until `NOT_APP` names it, and a missing `config.js` is a
  FAIL, not a pass. `npm run test:tools` → 32 tests, 32 pass. On the real v1.8.0 files, rebuilt from
  `main` and the release diff:

  ```bash
  d=$(mktemp -d) && git archive main app deploy | tar -x -C "$d" && (cd "$d" && git apply) < incident/changes/v1.8.0.diff && node tools/check-deploy.mjs --root "$d" | grep '^E1'
  ```

  → `E1  FAIL ... api: not read by app/src/config.js: DB_POOL_SIZE; api: missing:
  DB_POOL_MAX; worker: not read by app/src/config.js: DB_POOL_SIZE; worker: missing:
  DB_POOL_MAX`. On the current `deploy/compose.yaml`, `npm run check:deploy` →
  `E1  PASS`.
- **Why it catches a class of problems, not only this incident:** every variable in
  `config.js` has a fallback (`app/src/config.js:6-15`), so any rename, typo or removal
  between the deploy file and the code changes the service silently: without
  `SMS_RATE_PER_SEC` the SMS rate drops from the `"20"` set for both services in
  `deploy/compose.yaml` to 5 (`app/src/config.js:13`). A rename or a typo leaves an unknown
  name (check 1) and a missing one (check 2); a removal leaves a missing one (check 2); a
  value moved out of the file and not provided, for example `${DB_POOL_MAX}` with no
  `DB_POOL_MAX` in `deploy/.env`, leaves an empty one (check 3), which ends in the same pool
  of 4 as on 2026-10-14. The rule compares the two lists instead of looking for one variable
  name. What it does not judge is whether a non-empty value is valid (`"0"` or `"abc"` also
  falls back, `app/src/config.js:9`): that is action item 1.
