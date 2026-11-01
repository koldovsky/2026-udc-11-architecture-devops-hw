# RCA: incident of 2026-10-14

> Task C. Every claim comes with a command that runs from the repository root in Git Bash
> and with its output. Times are Europe/Kyiv.

## Summary

From 14:02 to 14:47 the parcel lockers answered part of the pickup attempts with "Service
busy, try again later": 3,380 API requests failed with 503, 2,586 of them pickups, about
11 % of all requests in that window. Release v1.8.0 renamed the environment variable
`DB_POOL_MAX` to `DB_POOL_SIZE` in `deploy/compose.yaml`; the service still reads
`DB_POOL_MAX` and, when it is missing, silently falls back to a pool of 4 connections
instead of 20, which is too few for the afternoon load. The rollback to v1.7.3 at 14:47
restored the variable and the service recovered within a minute.

## Setup for the commands

Commands inside the tables are written for the rendered page: in a table cell GitHub shows
`\|` as `|`. When copying a command from the raw file, type `|` instead of `\|`.

Some rows use a helper that summarises a metrics file over a time window. Define it once
in the shell:

```bash
# window FROM TO FILE: per-window summary of a metrics CSV (columns: incident/README.md)
window() {
  awk -F, -v from="$1" -v to="$2" -v min=999 '
    NR > 1 && substr($1, 12, 5) >= from && substr($1, 12, 5) < to {
      n++; rps += $2; err += $4; sms += $8
      if ($3 > p95) p95 = $3
      if ($5 < min) min = $5
      if ($5 > max) max = $5
      if ($6 > wait) wait = $6
      if ($7 > heap) heap = $7
    }
    END { printf "rps avg %.1f | p95_ms max %d | error_rate avg %.3f | db_pool_in_use %d-%d | db_pool_waiting max %d | heap_used_pct max %d | sms_429_per_min avg %.1f\n", rps / n, p95, err / n, min, max, wait, heap, sms / n }
  ' "$3"
}
```

The API logs every 5xx response and only 1 in 100 of the others
(`incident/README.md:31`), so the 503 counts below are exact and the counts of other
requests are a 1 % sample.

## Timeline (Europe/Kyiv)

| Time | Event | Source (file or command) |
|---|---|---|
| 13:32 | `sms_429_per_min` goes above 20 for the first time; on 2026-10-13, a normal day without deploys, it does so at the same minute | evidence 15 |
| 13:37 | `SmsProvider429RateHigh` (warning) fires | `incident/alerts.json:10` |
| 13:40 | On-call engineer notes that SMS messages are still delivered, with delay, and leaves the warning alone | `incident/oncall-chat.md:6` |
| 14:01:37 | One SMS send in the worker (still v1.7.3) fails with `TLS handshake timeout to sms.example.net` | evidence 17 |
| 14:01:58 | API receives SIGTERM: the v1.8.0 deploy starts | `grep -h '"shutting down"' incident/logs/api-2026-10-14.jsonl` |
| 14:02:00 | v1.8.0 deployed ("config cleanup (#212)"); API starts with version 1.8.0, worker at 14:02:07 | `incident/deploys.log:7`, evidence 4, evidence 18 |
| 14:02 | `db_pool_in_use` drops from 12 to 4 and `db_pool_waiting` rises from 0 to 4 | `sed -n '/T14:01/,/T14:03/p' incident/metrics/2026-10-14.csv` |
| 14:02:07 | First 503 `db pool wait timeout after 2000ms` | evidence 7 |
| 14:03 | p95 above 2,000 ms (2,446) | evidence 13 |
| 14:04 | `error_rate` above 5 % (0.0684) | evidence 13 |
| 14:06 | `ApiLatencyP95High` (page) fires | `incident/alerts.json:18` |
| 14:07 | `Api5xxRateHigh` (page) fires | `incident/alerts.json:26` |
| 14:08 | Hotline: lockers show "Service busy, try again later", residents cannot collect parcels | `incident/oncall-chat.md:9` |
| 14:10–14:14 | On-call suspects the SMS provider, then a memory leak; the release author says v1.8.0 only tidied the config and the SMS text | `incident/oncall-chat.md:10-13` |
| 14:17 | Ticket opened with the SMS provider | `incident/oncall-chat.md:14` |
| 14:20:31 | API restarted, still v1.8.0: the pool stays at 4; the queue drops to 6 for one minute and is back at 20 by 14:21 | `incident/deploys.log:8`, evidence 12 |
| 14:29 | `/health` has answered 200 throughout | `incident/oncall-chat.md:17` |
| 14:36 | SMS provider reports no incident on its side | `incident/oncall-chat.md:18` |
| 14:46:58 | Last 503 | evidence 7 |
| 14:47:00 | Rollback to v1.7.3; API starts with version 1.7.3 | `incident/deploys.log:9`, evidence 4 |
| 14:47 | `db_pool_in_use` 14, `db_pool_waiting` 0, p95 618 ms; 296 ms at 14:48 | evidence 12 |
| 14:48 | Both page alerts resolve | `incident/alerts.json:19`, `incident/alerts.json:27` |
| 14:59 | Last minute with `sms_429_per_min` above 20 (2026-10-13: 14:57) | evidence 15 |
| 15:03 | `SmsProvider429RateHigh` resolves | `incident/alerts.json:11` |

## Root cause

1. **What changed.** Release v1.8.0, titled "config cleanup", sorted the environment
   variables in `deploy/compose.yaml` alphabetically and, among the moved lines, renamed
   `DB_POOL_MAX` to `DB_POOL_SIZE` for both the `api` and `worker` services (evidence 1).
   No code that reads the configuration changed (evidence 3).
2. **What became different.** The service reads only `DB_POOL_MAX` and, when the variable
   is absent, uses 4 — a default meant for local development (`app/src/config.js:8-9`,
   evidence 2). Nothing reports this: there is no error, no warning, and the startup log
   prints only the version (evidence 4). After the deploy at 14:02 the API pool allowed 4
   connections instead of 20, and `db_pool_in_use` sat at exactly 4 for 45 minutes
   (evidence 5).
3. **Why users saw "Service busy".** The afternoon peak (11.8 requests per second, the
   same as the day before) needs 10–13 connections at once (evidence 6). With 4, requests
   queue (`db_pool_waiting` up to 23); a request that waits longer than
   `DB_POOL_WAIT_MS` = 2,000 ms gets `PoolTimeoutError` (`app/src/db.js:74-77`), which the
   API turns into 503 `service busy, try again` (`app/src/server.js:65`, evidence 9). Every
   one of the 3,380 503s is this timeout (evidence 7). Pickup has most of the 503s (2,586
   of 3,380, 77 %, evidence 8) mainly because it is most of the traffic: 76 % of the
   sampled requests before the deploy and 63 % in the same window on 13.10 (evidence 22).
   A 1 % sample that varies this much cannot show whether pickups also failed more often
   than other requests. What it changes is the duration: `POST /pickup` takes a pool
   connection three times in a row — find the parcel, mark it picked up, record the event
   (`app/src/parcels.js:61,64,67`, evidence 10) — so one pickup can queue three times. That
   is why p95 reached almost 5 s (4,962 ms, evidence 5), well above the 2-second wait
   limit, and single pickups failed after up to 5.6 s (evidence 11, 14).
4. **Why monitoring of health stayed green and the restart did not help.** `GET /health`
   returns 200 without touching the database (`app/src/server.js:37`, evidence 9). The
   restart at 14:20 started the same release with the same environment, so the pool was
   again 4 (evidence 12).
5. **Why it recovered exactly at 14:47.** The rollback to v1.7.3 brought back the compose
   file with `DB_POOL_MAX: "20"`. In the first minute after it `db_pool_in_use` went to 14
   — above the old cap of 4 — the queue emptied and p95 fell from 4,697 ms to 618 ms, then
   to 296 ms (evidence 12). No 503 appears after 14:46:58 (evidence 7).

### Side effect to check: pickups that failed after the status change

A pickup that times out on its third connection has already marked the parcel
`picked_up` (`app/src/parcels.js:64-66`) but has not recorded the event and has answered
the locker with 503. A failure on the first connection takes about 2,000 ms. A failure on
the second takes less than 2,000 ms of waiting for the first connection, plus the first
query, plus 2,000 ms, so it goes above 4,300 ms only when the first query takes more than
300 ms. That is rare but possible: before the deploy the per-minute p95 never exceeded
262 ms (evidence 5), yet 10 of the 542 sampled requests took longer, the slowest 694 ms
(evidence 19). A failure on the third connection, in turn, can be faster than 4,300 ms
when the first two waits were short. So the 135 pickups that failed after more than
4,300 ms (evidence 14) are not a count of the pickups that failed on the third step: a few
of them may have failed on the second step, and third-step failures faster than 4,300 ms
are not among them. The durations show no gap that would separate the steps. Whether the
locker door opened for them is not in the data. The production database has to be checked
for parcels marked `picked_up` between 14:02 and 14:47 Europe/Kyiv without a `picked_up`
event (post-mortem action item 8). That is 11:02–11:47 UTC: the code writes `pickedUpAt`
with `toISOString()` (`app/src/parcels.js:63`), so a query with the local times would
miss every row; how the production database stores the field is not in this repository.

## Evidence

| # | Claim | Command (from the repository root) | Result |
|---|---|---|---|
| 1 | v1.8.0 renamed `DB_POOL_MAX` to `DB_POOL_SIZE` for both services | `grep -n "DB_POOL_" incident/changes/v1.8.0.diff` | lines 86–87 and 106–107: `-DB_POOL_MAX: "20"` / `+DB_POOL_SIZE: "20"`; `DB_POOL_WAIT_MS` unchanged (88, 108) |
| 2 | The code reads only `DB_POOL_MAX`, default 4; nothing reads `DB_POOL_SIZE` | `grep -rn "DB_POOL" app/src` | `app/src/config.js:9: dbPoolMax: Number(env.DB_POOL_MAX) \|\| 4,` and line 10 for `DB_POOL_WAIT_MS`; no other match |
| 3 | v1.8.0 did not touch the API code or `config.js` | `grep "^diff --git" incident/changes/v1.8.0.diff` | 5 files: `app/README.md`, `app/package.json`, `app/src/worker.js`, `app/test/worker.test.js`, `deploy/compose.yaml` |
| 4 | API ran 1.8.0 from 14:02:00, again after the restart at 14:20:31, and 1.7.3 from 14:47:00; the startup line has no configuration values | `grep -h '"version"' incident/logs/api-2026-10-14.jsonl` | three `service started` lines: 14:02:00.087 `1.8.0`, 14:20:31.112 `1.8.0`, 14:47:00.236 `1.7.3`; fields: `ts`, `level`, `msg`, `version` only |
| 5 | Between deploy and rollback the pool was pinned at exactly 4 and requests queued; before and after it was not | `window 12:00 14:02 incident/metrics/2026-10-14.csv; window 14:02 14:47 incident/metrics/2026-10-14.csv; window 14:47 16:00 incident/metrics/2026-10-14.csv` | before: `p95_ms max 262`, `db_pool_in_use 2-13`, `db_pool_waiting max 0`, `heap_used_pct max 82`; incident: `rps avg 11.8`, `p95_ms max 4962`, `error_rate avg 0.107`, `db_pool_in_use 4-4`, `db_pool_waiting max 23`, `heap_used_pct max 82`; after: `db_pool_in_use 2-14`, `db_pool_waiting max 0`, `heap_used_pct max 82` |
| 6 | The same window on 2026-10-13 had the same load and needed 10–13 connections | `window 14:02 14:47 incident/baseline/metrics-2026-10-13.csv` | `rps avg 11.8`, `p95_ms max 255`, `db_pool_in_use 10-13`, `db_pool_waiting max 0`, `heap_used_pct max 82` (14.10: `rps avg 11.8`) |
| 7 | All 503s are pool wait timeouts, from 14:02:07 to 14:46:58; none on 13.10 | `grep -c '"status":503' incident/logs/api-2026-10-14.jsonl; grep -c "db pool wait timeout after 2000ms" incident/logs/api-2026-10-14.jsonl; grep '"status":503' incident/logs/api-2026-10-14.jsonl \| sed -n '1p;$p' \| cut -c19-30; grep -c '"status":503' incident/baseline/api-2026-10-13.jsonl` | `3380`, `3380`, `14:02:07.172`, `14:46:58.204`, `0` |
| 8 | Pickup is the most affected endpoint | `grep '"status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | `144 "path":"/admin/parcels"`, `650 "path":"/parcels"`, `2586 "path":"/pickup"` |
| 9 | A caller that waits longer than the pool wait gets `PoolTimeoutError`, which becomes 503 "service busy"; `/health` does not use the database | `grep -n -e "setTimeout" -e "new PoolTimeoutError" app/src/db.js; grep -n "service busy" app/src/server.js; grep -n '"/health"' app/src/server.js` | `74: waiter.timer = setTimeout(() => {` and `77: reject(new PoolTimeoutError(waitMs));` (the timer runs for `waitMs`, `app/src/db.js:72-78`), then `65: if (err instanceof PoolTimeoutError) [status, body] = [503, { error: "service busy, try again" }];`, then `37: if (method === "GET" && path === "/health") return [200, { status: "ok", version }];` and `75: else if (path !== "/health" && ++seen % ACCESS_LOG_EVERY === 0) log.info("request", fields);` (line 75: `/health` is never logged) |
| 10 | `POST /pickup` takes a pool connection three times | `grep -n "withConnection" app/src/parcels.js` | 7 lines: `43`, `61`, `64`, `67`, `74`, `80`, `85`. Lines 61, 64 and 67 are inside `pickup()` (`app/src/parcels.js:59-69`); 43 is `registerParcel`, 74 `listForAdmin`, 80 `findExpired`, 85 `markReturned` |
| 11 | Failed pickups waited from 2.0 up to 5.6 s | `grep '"path":"/pickup","status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| sort -n \| sed -n '1p;$p'` | `2000`, `5607` |
| 12 | The restart did not change the pool; the rollback did | `sed -n '/T14:19/,/T14:22/p' incident/metrics/2026-10-14.csv; sed -n '/T14:45/,/T14:49/p' incident/metrics/2026-10-14.csv` | 14:19–14:22: `db_pool_in_use` 4, 4, 4, 4; `waiting` 23, 6, 20, 19; `heap_used_pct` 81, 43, 42, 49. 14:45–14:49: `in_use` 4, 4, 14, 11, 12; `waiting` 20, 17, 0, 0, 0; `p95_ms` 4684, 4697, 618, 296, 232 |
| 13 | p95 crossed 2 s at 14:03 and the error rate crossed 5 % at 14:04, matching alerts that need 3 minutes above the threshold (14:06, 14:07) | `awk -F, 'NR>1 && $3 > 2000 {print substr($1,12,5); exit}' incident/metrics/2026-10-14.csv; awk -F, 'NR>1 && $4 > 0.05 {print substr($1,12,5); exit}' incident/metrics/2026-10-14.csv` | `14:03`, `14:04` |
| 14 | 135 pickups failed after more than 4.3 s, most likely on the third connection; this is not a count of all third-step failures (see "Side effect to check"), and the durations spread without a gap between the steps | `grep '"path":"/pickup","status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| awk '$1 > 4300' \| wc -l; grep '"path":"/pickup","status":503' incident/logs/api-2026-10-14.jsonl \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| awk '{c[int($1/500)*500]++} END {for (k in c) print k, c[k]}' \| sort -n` | `135`; then 500 ms buckets (lower bound, count): `2000 1577`, `2500 272`, `3000 286`, `3500 239`, `4000 122`, `4500 60`, `5000 26`, `5500 4` |
| 15 | The SMS 429 pattern is the same on both days | `for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do awk -F, 'NR>1 && $8 > 20 {n++; if (!s) s=substr($1,12,5); e=substr($1,12,5)} END {print FILENAME, n, "minutes, first", s, "last", e}' "$f"; done` | 14.10: `88 minutes, first 13:32 last 14:59`; 13.10: `86 minutes, first 13:32 last 14:57` |
| 16 | The `SmsProvider429RateHigh` condition (above 20 for 5 minutes) was met at the same minute on the normal day | `for f in incident/metrics/2026-10-14.csv incident/baseline/metrics-2026-10-13.csv; do awk -F, 'NR>1 && $8>20 {run++; if (run==5 && !f) f=substr($1,12,5)} NR>1 && $8<=20 {run=0} END {print FILENAME, f}' "$f"; done` | `13:36` on both days, so the alert would have fired at 13:37 on 13.10 too |
| 17 | The TLS timeout is a one-off on both days: 14:01:37 on 14.10, 13:12:45 on 13.10 | `grep -c "TLS handshake timeout" incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl; grep -h "TLS handshake timeout" incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl \| cut -c8-30` | `incident/logs/worker-2026-10-14.jsonl:1`, `incident/baseline/worker-2026-10-13.jsonl:1`, `2026-10-14T14:01:37.954`, `2026-10-13T13:12:45.343` |
| 18 | The worker restarted with 1.8.0 at 14:02:07 and with 1.7.3 at 14:47:01 | `grep -h '"version"' incident/logs/worker-2026-10-14.jsonl` | two `worker started` lines: 14:02:07.013 `1.8.0`, 14:47:01.305 `1.7.3` |
| 19 | Before the deploy single requests sometimes took longer than 262 ms (1 % sample) | `grep '"msg":"request"' incident/logs/api-2026-10-14.jsonl \| awk '{t=substr($0,19,5)} t<"14:02"' \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| awk '{n++; if ($1 > 262) k++; if ($1 > m) m = $1} END {print n, "sampled,", k, "above 262 ms, max", m}'` | `542 sampled, 10 above 262 ms, max 694` |
| 20 | During the outage responses other than 5xx were slow too (1 % sample) | `grep '"msg":"request"' incident/logs/api-2026-10-14.jsonl \| awk '{t=substr($0,19,5)} t>="14:02" && t<"14:47"' \| grep -o '"ms":[0-9]*' \| cut -d: -f2 \| sort -n \| awk '{a[NR]=$1} END {print "n", NR, "median", a[int(NR*0.5)+1], "p95", a[int(NR*0.95)+1], "max", a[NR]}'` | `n 283 median 1781 p95 3375 max 3777` |
| 21 | At noon a pool of 4 was almost enough: on both days only 6 of the 60 minutes between 12:00 and 13:00 used more than 4 connections | `for f in incident/baseline/metrics-2026-10-13.csv incident/metrics/2026-10-14.csv; do awk -F, 'NR>1 && substr($1,12,5) >= "12:00" && substr($1,12,5) < "13:00" {n++; if ($5 > 4) k++} END {print FILENAME, k, "of", n, "minutes above 4"}' "$f"; done` | `incident/baseline/metrics-2026-10-13.csv 6 of 60 minutes above 4`, `incident/metrics/2026-10-14.csv 6 of 60 minutes above 4` |
| 22 | Pickup is most of the traffic, but its share in the 1 % sample varies: 76 % before the deploy on 14.10, 63 % in the outage window on 13.10 | `grep '"msg":"request"' incident/logs/api-2026-10-14.jsonl \| awk '{t=substr($0,19,5)} t<"14:02"' \| grep -o '"path":"[^"]*"' \| sort \| uniq -c; grep '"msg":"request"' incident/baseline/api-2026-10-13.jsonl \| awk '{t=substr($0,19,5)} t>="14:02" && t<"14:47"' \| grep -o '"path":"[^"]*"' \| sort \| uniq -c` | 14.10 before 14:02: `55 "path":"/admin/parcels"`, `76 "path":"/parcels"`, `411 "path":"/pickup"` (411 of 542); 13.10, 14:02–14:47: `26 "path":"/admin/parcels"`, `92 "path":"/parcels"`, `201 "path":"/pickup"` (201 of 319). For comparison, 503s: 2,586 of 3,380 are pickups (evidence 8) |

## What in the data is NOT the cause — and how that is shown

Every cause named by at least one AI run or by the on-call chat, and the ones suspected
during this analysis.

| Hypothesis | Why it looked plausible | How it is refuted (command → result) |
|---|---|---|
| The SMS provider throttling (429) brought the service down (on-call at 14:10) | A warning alert 30 minutes before the outage; 3,065 `sms provider rate limited` lines on the day | The same pattern on the normal day: `grep -c "sms provider rate limited" incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl` → `incident/logs/worker-2026-10-14.jsonl:3065`, `incident/baseline/worker-2026-10-13.jsonl:2935`; 88 vs 86 minutes above 20, from 13:32 on both days (evidence 15); the alert condition was met at 13:36 on both days (evidence 16). 429s continued at the same level after the rollback while the API recovered: `window 14:47 15:00 incident/metrics/2026-10-14.csv` → `sms_429_per_min avg 33.4`, `error_rate avg 0.002`. The API code does not call the SMS provider; only the worker imports the SMS client: `grep -rn 'sms.js' app/src` → `app/src/worker.js:5:import { createSmsClient } from "./sms.js";` and no other match. |
| A separate "incident B": 429s caused by load growth from ~4 to ~11 requests per second (run 1) | The load did grow 2.5 times during the afternoon | The same growth and the same 429s on 13.10: `window 12:00 14:02 incident/metrics/2026-10-14.csv; window 12:00 14:02 incident/baseline/metrics-2026-10-13.csv` → `rps avg 7.4`, `sms_429_per_min avg 8.6` (14.10) vs `rps avg 7.4`, `sms_429_per_min avg 8.5` (13.10); evidence 6 and 15. This is the daily afternoon peak, not an incident. |
| The SMS provider started failing before the deploy (`TLS handshake timeout` at 14:01:37, on-call at 14:14) | It is the first `error` line before the outage | One such line on each day (evidence 17). It is a worker SMS send; all 3,380 API 503s are pool timeouts (evidence 7), and the worker sends SMS outside any database connection: `sed -n '24,33p' app/src/worker.js` → `listUnnotified` and `updateParcel` each in their own `withConnection`, `sms.send` between them. |
| A memory leak in the API (heap 81 %, `heap usage high`; on-call at 14:12) | High heap in the middle of the outage | `grep -c "heap usage high" incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `63` and `70`; the first warning is at the same time on both days: `for f in incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl; do grep -m1 "heap usage high" "$f" \| cut -c8-30; done` → `2026-10-14T12:02:17.204`, `2026-10-13T12:02:17.204`. The logs start at 12:00 (`incident/README.md:15`), so the warnings may start earlier. `heap_used_pct max 82` before, during and after the outage on 14.10 and in the same window on 13.10 (evidence 5, 6). The 14:20 restart reset the heap from 81 % to 43 % and changed nothing (evidence 12). |
| A traffic spike (suspected during this analysis) | Latency and errors rose at the busiest hour | `rps avg 11.8` from 14:02 to 14:47 on both days (evidence 5, 6). |
| The database server was slow or down (suspected during this analysis) | Every 503 says "db pool" | A slow database would hold connections longer and push `db_pool_in_use` towards the configured 20; it stayed at exactly 4, the code default (evidence 5). The worker, which uses the same database, kept working: `for f in incident/logs/worker-2026-10-14.jsonl incident/baseline/worker-2026-10-13.jsonl; do grep '"sms batch sent"' "$f" \| cut -c19-23 \| awk '$1 >= "14:02" && $1 < "14:47"' \| wc -l; done` → `211` vs `205`. |
| The worker part of the 1.8.0 release holds or shares the API's connections (run 1) | Run 1 saw only the worker's `version` field change at 14:02 | The API restarted with 1.8.0 at the same time (evidence 4). `db_pool_in_use` is the pool of the API process (`incident/README.md:46`). The worker is a separate compose service with its own environment and pool: `git show c6800ab:deploy/compose.yaml \| grep -n "^  [a-z]*:$"` → `4: api:`, `23: worker:`. That file is the v1.7.3 compose: `git show c6800ab:deploy/compose.yaml \| git hash-object --stdin` starts with `04f266e`, the "before" hash of the compose in the release diff (`incident/changes/v1.8.0.diff:67`). The worker code change is the SMS text and one log message: `sed -n '25,46p' incident/changes/v1.8.0.diff \| grep '^[-+] '` → 4 lines: the old and the new `arrivalText` template, and `"sms send failed"` → `"sms delivery failed"`. |
| The release leaks or holds connections in the API, so the pool fills up (run 1) | The pool was full and requests queued from the deploy minute | v1.8.0 did not change the API code (evidence 3). A leak with the configured 20 connections would fill the pool gradually, towards 20; instead `db_pool_in_use` went from 12 to exactly 4 in the deploy minute (timeline, 14:02) and stayed at 4 (evidence 5). The restart at 14:20, which releases every held connection, did not change it: again exactly 4, with the queue back at 20 a minute later (evidence 12). |
| 500 `Cannot read properties of undefined (reading 'trim')` on `POST /parcels` (both runs) | `error` lines with a stack-trace-like message | `grep -c "reading 'trim'" incident/logs/api-2026-10-14.jsonl incident/baseline/api-2026-10-13.jsonl` → `125` and `128`. The first one on 14.10 is before the deploy: `grep -m1 "reading 'trim'" incident/logs/api-2026-10-14.jsonl \| cut -c8-30` → `2026-10-14T12:39:18.045`. All of them are 500, not 503: `grep "reading 'trim'" incident/logs/api-2026-10-14.jsonl \| grep -o '"status":[0-9]*' \| sort \| uniq -c` → `125 "status":500`. A separate bug, present on both days. |
| A restart clears whatever state is stuck (on-call action at 14:20) | Restarts often fix leaks and stuck connections | The pool stayed at 4 after the restart (evidence 12): the process re-read the same environment. |

## Contributing factors

- **Silent default.** `app/src/config.js:8-9` falls back to a development value when
  `DB_POOL_MAX` is missing. In production a missing variable cannot be told apart from an
  intended value, and the service starts without any warning.
- **Effective configuration is not visible.** The startup log line contains only the
  version (evidence 4), so neither the deploy nor the 14:20 restart showed the pool size.
- **No check between the deploy file and the code.** Nothing compares the variable names
  in `deploy/compose.yaml` with what `app/src/config.js` reads. The deploy check has 13
  rules and none of them reads `config.js`: `git show c6800ab:tools/check-deploy.mjs | grep -c 'id: "'`
  → `13`; `git show c6800ab:tools/check-deploy.mjs | grep -n 'config\.js' | cut -d: -f1` →
  `453`, `521`, both lines are `hint:` texts about secret files. The config test sets
  `DB_POOL_MAX` itself (`app/test/config.test.js:17`), so it passes whatever compose says.
  The alphabetical sort produced 22 changed environment lines in the compose diff (11
  removed, 11 added), and the rename is one removed/added pair per service among them:
  `grep -c '^[-+]      [A-Z_]*:' incident/changes/v1.8.0.diff` → `22`.
- **`/health` checks only that the process answers** (`app/src/server.js:37`), so health
  checks stayed green during the outage (`incident/oncall-chat.md:17`).
- **Only symptom alerts paged.** The p95 and 5xx alerts fired; no alert on
  `db_pool_waiting`, the metric that pointed straight at the cause from 14:02, fired.
  `incident/alerts.json` lists only the alerts that fired (`incident/README.md:14`), so
  whether such an alert exists with a higher threshold is not in the data.
- **A noisy warning framed the investigation.** On 13.10, the only normal day in the
  data, the `SmsProvider429RateHigh` condition was met at the same minute (evidence 16),
  and the outage started after it, so the first hypotheses were about the SMS provider.
  The noise has a likely source in the configuration: the worker paced SMS at 20/s
  (`git show c6800ab:deploy/compose.yaml | grep -n SMS_RATE_PER_SEC` →
  `20:      SMS_RATE_PER_SEC: "20"`, `34:      SMS_RATE_PER_SEC: "20"`), while the provider
  accepts 10 messages per second and does not send the rest
  (`sed -n '16,17p' materials/vendors/sms-provider.md` → the account limit of 10 messages
  per second; above it `429 Too Many Requests`, and the message is not sent). The metrics have no send rate,
  so the data cannot prove this link; post-mortem action item 12 removes the suspected cause.
- **No "recent deploy first" step.** The deploy was mentioned in the chat 7 minutes after
  the first page (`incident/oncall-chat.md:12`); the rollback was decided 39 minutes after
  the first page, "just in case" (`incident/oncall-chat.md:19`).
- **Pickup is not atomic.** Three separate connections per pickup turn pool exhaustion
  into possible half-finished pickups (see "Side effect to check").

## Confidence

**High.** The pool metric changed from 12 to exactly 4 in the deploy minute and back to
14 in the rollback minute; 4 is the code default for a missing `DB_POOL_MAX`, and the diff
shows that variable disappearing from compose. The error text of all 3,380 failures names
the pool wait. The same hours on 13.10, with the same load, the same SMS 429s and the same
heap, had no queue. The restart, which kept the configuration, did not help; the
rollback, which changed it, did.

What is missing: the environment of the running container on 14.10 was not captured
(`printenv` or `docker inspect`), so the pool size of 4 is inferred from the metric and the
code, not read directly. The conclusion would change if the container had `DB_POOL_MAX=20`
set during the incident. The side effect on pickups needs the production database to
confirm.

## First AI answer vs second

| | `ai-runs/rca-v1.md` — alerts, logs, metrics | `ai-runs/rca-v2.md` — the whole `incident/` + `app/` + `deploy/` |
|---|---|---|
| What the AI named as the root cause | The 1.8.0 release "of the worker" at 14:02; mechanism inferred from metrics only: the DB pool was reduced to 4 or connections were held (smaller max, leak or long transactions). Plus a separate "incident B": SMS 429s caused by load growth | v1.8.0 renamed `DB_POOL_MAX` to `DB_POOL_SIZE` in compose; `app/src/config.js:9` falls back to 4; the API pool became 4 instead of 20 |
| Confidence the AI stated | High (~90 %) that the release caused the API degradation; ~65 % on the mechanism; medium-low on the cause of the 429s | High (~90 %) |
| Matches this RCA? | Partly: right trigger (the deploy at 14:02) and right symptom (pool pinned at 4); wrong component (the API restarted with 1.8.0 too), no mechanism, and a second incident that does not exist (the 429 pattern is daily) | Yes: the same mechanism and chain; SMS, TLS and heap dismissed with the baseline day |
| What in the data affected the answer | — | `incident/changes/v1.8.0.diff` (the rename) together with `app/src/config.js:9` (the default 4) turned "the pool is 4" into a mechanism; `incident/baseline/` showed 429s and heap as normal; `incident/deploys.log` explained the 14:20 restart. Run 1 itself named the missing release diff and pool configuration as the reason for its 65 % |
| What it missed | The daily 429 baseline (not in its data) | Half-finished pickups on the third connection; that the `SmsProvider429RateHigh` condition is met on the normal day too |
