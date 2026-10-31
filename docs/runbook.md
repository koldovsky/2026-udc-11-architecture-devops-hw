# Runbook: API latency and 5xx pages

> Task C. For the on-call engineer who did not see the incident of 2026-10-14
> ([`docs/rca.md`](rca.md)). Commands run on the production VM, in the directory that
> holds `deploy/compose.yaml`, as in [`docs/ops/backup-runbook.md`](ops/backup-runbook.md).
> That directory is the git checkout the deploy pipeline (`pipeline/deploy.yml`) switches
> to each release; its path is the `DEPLOY_PATH` variable of the `production` environment
> in the repository settings, and step 2 of "First 5 minutes" shows how to find it on the
> VM. Compose takes `IMAGE_TAG` and `SMS_TOKEN` from `deploy/.env` there
> (`deploy/compose.yaml:8-13`): without that file every `docker compose` command below
> stops with an error that names the missing variable. Then escalate to the infrastructure
> developer, and do not print the file: it holds the SMS token.

- **Alerts:** `ApiLatencyP95High` — `p95_ms > 2000` for 3 minutes (page);
  `Api5xxRateHigh` — `error_rate > 0.05` for 3 minutes (page). They usually fire
  together.
- **What it means for users:** after typing the code, the locker screen shows "Service
  busy, try again later" and the resident cannot collect the parcel; courier
  registrations (`POST /parcels`) and the staff parcel list fail the same way.
- **How much time there is:** none — users are already affected when the page arrives
  (the alert needs 3 minutes above the threshold). On 2026-10-14 about 75 requests failed
  per minute. A pickup that fails halfway can leave a parcel marked as picked up whose
  door may not have opened, so every minute also adds records to fix afterwards.

**Known noise, not a reason for this page:** on 2026-10-13, a normal weekday, the
`SmsProvider429RateHigh` condition was met at 13:36, the same minute as on the incident
day, and `heap usage high` warnings appeared in the API log on both days from the start of
the available logs (12:00) (`docs/rca.md`, evidence 16 and "What in the data is NOT the
cause"). The API does not call the SMS provider. Look at them only if the steps below
point there.

## First 5 minutes

1. Acknowledge the page in `#poshtomat-oncall`.
2. Find the deployment directory, then check which version runs and how long the
   containers have been up:

   ```bash
   ssh poshtomat-prod-1
   docker compose ls                             # CONFIG FILES: <dir>/deploy/compose.yaml of the running project
   cd <dir>                                      # the directory that holds deploy/
   git log -1 --format='%h %ci %s'               # the deployed commit and its time
   curl -s http://localhost:8080/health          # {"status":"ok","version":"<version>"}
   docker compose -f deploy/compose.yaml ps      # STATUS column: "Up 12 minutes" = recent (re)start
   ```

   `/health` does not use the database: a 200 here says only that the process is alive,
   not that pickups work.

   Container uptime alone does not show a deploy: a restart without a deploy resets it too
   (on 2026-10-14 the API was restarted at 14:20 with the same release,
   `incident/deploys.log:8`). Confirm a deploy in the checkout on the VM: its reflog records
   every switch to a release with the time, the pipeline's deploys and rollbacks by hand
   alike:

   ```bash
   git reflog --date=iso -n 5 --format='%gd %gs'   # HEAD@{<time>} checkout: moving from <previous> to <release>
   ```

   The deploy history of the VM (`incident/deploys.log` is a copy of it; its path on the VM
   is not in this repository) has the restarts and the deploys made by hand before the
   pipeline; the pipeline does not write to it. Recent merges to `main`, which the pipeline
   deploys after approval, show from any clone of the repository:

   ```bash
   git fetch origin && git log origin/main --since='2 hours ago' --format='%ci %s' -- app deploy
   ```
3. **A deploy or a configuration change in the last 60 minutes, and the page started
   after it → roll back first** (see "Rollback" under "What to do"), then continue the diagnosis. Do not
   wait for the cause.
4. Check whether the API can get a database connection, without side effects (a made-up
   staff token takes one pool connection for a read-only session lookup and changes
   nothing):

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
     -H 'Authorization: Bearer runbook-probe' http://localhost:8080/admin/parcels
   ```

   `403` in well under a second — the API gets a database connection right now: go to
   "Diagnosis" 1 to see what the failures are, then 5. Repeat the probe two or three
   times first: one fast answer can fall into a moment without a queue. `503` after
   2 seconds or more — the connection pool is exhausted, go to "Diagnosis". Do not probe with `POST /pickup` and a guessed code: if the code exists,
   that parcel is marked as picked up.

## Diagnosis

| Question | Command or place | How to read the result |
|---|---|---|
| 1. What do the failures say? | `docker compose -f deploy/compose.yaml logs --since 15m --no-log-prefix api \| grep '"level":"error"' \| grep -o '"error":"[^"]*"' \| sort \| uniq -c \| sort -rn` | `db pool wait timeout after 2000ms` at the top — requests wait for a database connection: continue with 2. Any other message on top — follow that message; this runbook does not cover it |
| 2. Is the pool too small or the database too slow? | Metrics `db_pool_in_use` and `db_pool_waiting` for the last 30 minutes, next to the same hours yesterday. The monitoring dashboard address is not in this repository yet. From a per-minute CSV export in the format of `incident/metrics/` (`ts,rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting,heap_used_pct,sms_429_per_min`): `awk -F, 'NR>1 {print substr($1,12,5), "in_use", $5, "waiting", $6}' <export>.csv \| tail -30`, for today's and yesterday's export | `db_pool_in_use` flat at one number below 20 (for example exactly 4) while `db_pool_waiting > 0` — the pool is smaller than configured: go to 3. `db_pool_in_use` at 20 and waiting — the database or the load: go to 4 and 5 |
| 3. What pool size does the running API use? | `docker compose -f deploy/compose.yaml exec api node -e 'import("./src/config.js").then(({ loadConfig }) => { const c = loadConfig(); console.log("dbPoolMax", c.dbPoolMax, "dbPoolWaitMs", c.dbPoolWaitMs); })'` | `dbPoolMax 20` — as intended. Any other number — the configuration is wrong. The command prints only the two pool values, never the tokens |
| 3a. Is the variable set at all? | `docker compose -f deploy/compose.yaml exec api printenv DB_POOL_MAX` | `20` — set. Empty output — missing (the 2026-10-14 case: it had been renamed to `DB_POOL_SIZE`, which the code does not read, so the code used its default of 4) |
| 4. Is the database answering? | `pg_isready -h 192.0.2.10 -p 5432` | `accepting connections` — the server is up; anything else — escalate to the infrastructure developer (owner of the VM and the database). Between 02:00 and 02:30 the backup blocks writes by design (`docs/ops/backup-runbook.md`) |
| 5. Is the load unusual? | Metric `rps` now vs the same time yesterday; from the CSV export of question 2: `awk -F, 'NR>1 {print substr($1,12,5), "rps", $2}' <export>.csv \| tail -10`, for today's and yesterday's export | about the same (the afternoon peak is ~12 requests per second) — not a load problem; much higher — escalate, find the source |

## How to confirm the cause

A pool that is too small, not a slow database:

- `db_pool_in_use` stays flat at the same value below 20 minute after minute, while
  `db_pool_waiting` is above 0 (Diagnosis 2), and
- the running API reports `dbPoolMax` other than 20 (Diagnosis 3).

A slow database or overload looks different: `db_pool_in_use` at 20, `pg_isready` slow
or failing, or `rps` well above the same hour yesterday. In both cases the log shows the
same `db pool wait timeout`, so the log alone does not tell them apart.

## What to do

| Situation | Action | Command | Risk / what to check after |
|---|---|---|---|
| A deploy in the last 60 minutes, cause unknown | Roll back to the previous release — `app/` **and** `deploy/compose.yaml` together — and rebuild the image | See "Rollback" below | A rollback of the image alone keeps a broken compose file. After it, check the version (`curl -s http://localhost:8080/health`), `dbPoolMax` (Diagnosis 3) and "How to make sure all is well" |
| `dbPoolMax` is not 20 because `DB_POOL_MAX` is missing or misnamed in compose | Put `DB_POOL_MAX: "20"` back into the shared `x-env:` block of `deploy/compose.yaml` (both `api` and `worker` take their variables from it), then recreate the containers | `docker compose -f deploy/compose.yaml up -d api worker` | Compose recreates only containers whose configuration changed; check Diagnosis 3 again. The edit leaves local changes in the VM checkout, and the pipeline does not deploy over them: merge the same fix to `main` and tell the release author. Rule E1 of the deploy checks fails on such a compose before a deploy, so this row matters only when the checks were bypassed |
| `pg_isready` fails or the database is slow | Escalate (see below) | — | Restarting the API does not help a slow database |
| `db_pool_in_use` pinned at 20 with a queue, `pg_isready` answers, `rps` about the same as yesterday, outside the backup window 02:00–02:30 | The API process may be holding its connections (a hung query, a code path that does not give the connection back); slow queries look the same in these metrics. Escalate to the infrastructure developer, and meanwhile restart the API once | `docker compose -f deploy/compose.yaml restart api` | A restart drops the requests in flight. If `db_pool_waiting` is above 0 again within 10 minutes, a restart does not hold: do not restart again, wait for the escalation |
| Nothing above matches | Escalate with what you found | — | — |

**A restart does not fix a configuration problem.** The process reads the same
configuration again; on 2026-10-14 the restart at 14:20 changed nothing. Restart only in the
"pinned at 20" case above.

### Rollback

Deploys go through `pipeline/deploy.yml`: after a merge to `main` and the approval of the
`production` environment, it switches the git checkout on the VM to the merged commit,
writes that commit to `IMAGE_TAG` in `deploy/.env` and runs
`docker compose -f deploy/compose.yaml up -d --build --wait`. The `app/` and `deploy/` of a
release are therefore one commit, and the image is built on the VM: `api` builds it from
`../app` and `worker` runs the same image (`grep -n -e 'image:' -e 'context:' -e '<<: \*app'
deploy/compose.yaml` shows one `image:` in the shared `x-app:` block, which both services
take, and one `context: ../app`). A rollback by hand does the same with the previous
release, without waiting for the pipeline and its approval.

A release is a commit, not a tag (`deploy/compose.yaml:3`): the pipeline neither tags it nor
writes the deploy history. The checkout remembers every switch in its reflog, so the release
that ran before is the one the latest switch moved from. The first two commands check the
checkout, the third finds that release.

```bash
git rev-parse --is-inside-work-tree                 # "true" = a git checkout
git status --short                                  # empty = no local edits on the VM
git reflog -n 5 --format='%h %gs'                   # top line: "checkout: moving from <previous> to <current>"
git switch --detach <previous>                      # app/ and deploy/ of the previous release together
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$(git rev-parse HEAD)/" deploy/.env   # the image tag names the commit it is built from
docker compose -f deploy/compose.yaml up -d --build --wait
```

`<previous>` is a commit, or the branch name `main` when the latest switch was the first
pipeline deploy over a checkout updated by hand. `<current>` in the top line must be the
running commit (`git rev-parse HEAD`; the pipeline switches by the full hash); if a rollback has already been done, the top
line is that rollback, so read the lines below it. Anything other than `true`, any output
from `git status --short`, or a top line that is not `checkout: moving from …` — stop and
call the release author or the infrastructure developer. Without the `sed` line the
previous release's code would be built under the tag of the broken commit. A release from
before the pipeline (v1.8.0 and older) has its own compose file with the fixed image
`poshtomat:latest` and no `IMAGE_TAG`; there the `sed` line changes nothing compose reads,
and the rollback works the same. To return to the current code later: merge the fix to
`main`, and the pipeline deploys it after approval.

## When to escalate and whom to call

- No improvement 15 minutes after a rollback or a configuration fix → service developer
  (owner of `app/`).
- `pg_isready` fails, or `db_pool_in_use` is at 20 with a queue → infrastructure
  developer (owner of the VM and the database).
- The queue comes back after the one restart in the "pinned at 20" case → service
  developer as well: whatever holds the connections, slow queries or the code, is still
  there.
- Load far above the usual afternoon peak → service developer.
- After recovery, if `POST /pickup` answered 503 during the incident → service developer
  and the project coordinator, who handles the hotline: some parcels may be marked as
  picked up while the door did not open, and fast failures can be among them too
  (`docs/rca.md`, "Side effect to check"; post-mortem action item 8). Count them with
  `docker compose -f deploy/compose.yaml logs --since 2h --no-log-prefix api | grep -c '"path":"/pickup","status":503'`,
  with `--since` covering the whole incident.

## How to make sure all is well

- The probe from step 4 of the first 5 minutes returns `403` in well under a second.
- No new pool timeouts: `docker compose -f deploy/compose.yaml logs --since 5m api | grep -c 'db pool wait timeout'` → `0`.
- For 10 minutes: `db_pool_waiting` is 0, `db_pool_in_use` moves up and down instead of
  staying flat, p95 is below 300 ms, `error_rate` below 0.01. On 2026-10-13, a normal day,
  p95 was 140–260 ms between 13:00 and 16:00 (from the repository root:
  `awk -F, 'NR>1 && substr($1,12,5) >= "13:00" {print $3}' incident/baseline/metrics-2026-10-13.csv | sort -n | sed -n '1p;$p'`
  → `140`, `260`).
- Both page alerts resolve; they need the values back under the threshold, so allow a few
  minutes.
- Post in `#poshtomat-oncall` what was done and at what time; that is the timeline for
  the RCA.
