- Інструмент і модель: Claude Code, Claude Opus 5.5 (`claude-opus-5-5`)
- Дата: 2026-11-04
- Що бачила сесія:
  - Prompt 1: a temporary folder, `ws11-c1/incident/`, holding only `alerts.json`, `logs/` and `metrics/`.
  - Prompt 2: the same files in this repo (byte-identical, checked with `cmp`), plus `docs/rca.md`, `ai-runs/README.md`, `AGENTS.md`, `CLAUDE.md` and the repo's file listing, used for format and rules.
  - The session saw the file names and the one-line `AGENTS.md` description of the other incident data. It did not open `incident/README.md`, `incident/deploys.log`, `incident/oncall-chat.md`, `incident/changes/`, `incident/baseline/`, `app/` or `deploy/`.
- Промпт (дослівно):

  Prompt 1:

  > Ти — черговий інженер сервісу «Поштомат громади». 14 жовтня 2026 року спрацювали алерти.
  >    У теці — усе, що є про цей інцидент. Що сталося і чому? Назви першопричину,
  >    наскільки ти впевнений і на які дані спираєшся.
  >    Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  >    припущення називай явно.

  Prompt 2:

  > Compose/populate(
  >
  > `docs/rca.md` (шаблон є): хронологія; першопричина; таблиця доказів
  >    «твердження → команда → результат» — кожен рядок можна повторити з кореня репо;
  >    **що з даних НЕ є причиною — і чим це доведено**: кожна причина, яку назвав хоч один
  >    прогін AI і яку ви відкинули, і те, що підозрювали ви самі; чинники, що сприяли;
  >    впевненість.
  >
  > )  rca-v1.md based on template /Users/vlad/Projects/rbi_ai_training/hw/2026-udc-11-architecture-devops-hw/docs/rca.md and put into /Users/vlad/Projects/rbi_ai_training/hw/2026-udc-11-architecture-devops-hw/ai-runs folder

This file has two parts. Part 1 is the first answer to prompt 1, verbatim, as `ai-runs/README.md` requires. Part 2 is the answer to prompt 2, which is a later write-up and not a first answer.

---

# Part 1: first answer to prompt 1 (verbatim)

# Incident on 14 Oct 2026: release 1.8.0 limited the DB connection pool to 4

**Root cause:** release 1.8.0, deployed at 14:01:58, is what broke the service. The API could only use 4 DB connections, so requests queued for the pool and failed after the 2-second wait limit. The rollback to 1.7.3 at 14:46:58 fixed it immediately.

The folder can't show which change in 1.8.0 caused this, because it has no diff, config or DB logs. The SMS 429s came first, but they are a separate problem that didn't cause the outage.

All times are Kyiv time.

## Confidence
| Conclusion | Confidence | Basis |
|---|---|---|
| The 1.8.0 release triggered the incident | **High, about 95%** | Onset and recovery both match the version changes, at the same load |
| The mechanism was DB pool starvation with an effective limit of 4 | **High, about 85%** | 3,380 identical pool errors, and `db_pool_in_use` stuck at 4 |
| The defect is specifically a lowered pool setting | **Medium-low, about 50–60%** | Indirect evidence only, and the arithmetic below doesn't fully fit |

## Timeline
| Time | Event |
|---|---|
| 13:28 | SMS volume starts rising from about 15 to about 180 messages/min, and the first 429s appear |
| 13:37 | `SmsProvider429RateHigh` fires (warning); API is healthy, with p95 around 240 ms and no pool waiting |
| 14:01:58 | API receives SIGTERM, and the worker follows at 14:01:59 |
| 14:02:00 | API 1.8.0 starts; pool use drops from about 12 to 4 and requests start waiting |
| 14:02:07 | First `db pool wait timeout after 2000ms` |
| 14:06 / 14:07 | Latency and 5xx pages fire; p95 reaches about 4,700 ms and errors about 11% |
| 14:20:31 | API restarts, still on 1.8.0 (worker not restarted); no real improvement |
| 14:47:00 | API returns to 1.7.3, and the worker follows at 14:47:01; no 503s after this |
| 14:48 | Latency and 5xx alerts resolve |
| 15:02 | SMS 429s stop, and that alert resolves at 15:03 |

## Key evidence
- **Same load, different result:** at about 11–12 rps with SMS 429s active throughout, only the version changed.

  | Period | Version | Pool in use | Waiting | p95 | Errors |
  |---|---|---|---|---|---|
  | 13:28–14:02 | 1.7.3 | 10–13 | 0 | about 236 ms | 0.2% |
  | 14:02–14:47 | 1.8.0 | **always 4** | up to 23 | about 4,500 ms | about 11% |
  | 14:47–15:02 | 1.7.3 | 9–14 | 0 | about 254 ms, after 618 ms in the first minute | 0.1% |

- **Pool errors account for the outage:** all 3,380 503s carry the same pool error, and they span all three endpoints. That is about 10.6% of roughly 31,900 requests.
- **Only DB-dependent requests slowed:** responses that fail before reaching the DB stayed fast, with 400s at about 5 ms and the `trim` 500s at about 8 ms. Typical successful latency rose from about 74 ms to about 1,860 ms. That rules out a general CPU or process problem.
- **A hard limit fits better than a leak:** usage sat at exactly 4 for all 45 minutes. A leak would normally climb and then recover well after a restart, but the 14:20 restart gave almost no relief.

## Ruled-out causes
| Hypothesis | Why not |
|---|---|
| SMS 429s or retries | They began 34 minutes before the outage and continued 15 minutes after it, with the API healthy both times |
| Traffic spike | rps stayed flat at about 12 when the outage began, and the same load was fine on 1.7.3 |
| Memory | The heap follows its usual sawtooth and peaks at 82% all day, with similar warning counts every hour |
| `trim` TypeError on `/parcels` | Only 125 cases, starting at 12:39 and seen on both versions, at a steady 0.6% of estimated creates; a real bug, but not this incident |
| TLS timeout at 14:01:37 | A single worker event, and sending continued 2 seconds later |
| A stuck process | Restarting the API on the same version didn't help |

## What the data doesn't explain
- **The arithmetic doesn't fully fit:** at 1.7.3 speeds (about 74 ms per request), 4 connections could handle about 50 rps, so a low limit alone shouldn't overload the service at 12 rps. Serving 10.5 rps through 4 connections implies about 0.38 s per request, about 5 times longer. So 1.8.0 may also hold connections longer, or the metric may not mean what it appears to.
- **Possible second factor:** at least 1,009 of the 2,586 `/pickup` 503s took 2.5 s or more, up to 5.6 s, which suggests several pool acquisitions per request. If that's new in 1.8.0, it could explain the longer holds.
- **The API isn't proven to be the source:** API and worker rolled back within a second of each other. The worker's sending never slowed, which points to the API, but that isn't proof.
- **Slow start:** 503s built up over about 3 minutes after 14:02, but within about a minute after 14:20. I can't explain the difference.

## Assumptions
- `db_pool_*` describes the API's pool. Its definition isn't in the folder.
- The pool limit on 1.7.3 was at least 14, the highest value observed.
- Non-5xx requests are logged at about 1%, while 5xx are logged in full. The logged counts match the metrics closely (0.97–1.02% in every period), but the setting itself isn't documented.
- The SMS surge came from a bulk parcel registration. Estimated creates of about 200/min roughly match about 180 SMS/min, but the source isn't identified.

## Next steps
1. **Confirm the cause:** compare 1.7.3 and 1.8.0 for pool size, environment settings, the DB client version, and how connections are acquired and released in `/pickup`. Keep 1.8.0 off production until this is done.
2. **Reproduce it:** run 1.8.0 in staging at about 12 rps with pool metrics on, and check whether raising the limit alone fixes it.
3. **Check for damaged data:** look at the 1,009+ `/pickup` requests that may have failed partway, and the 650 failed `POST /parcels` that may need resubmitting.
4. **Handle the separate problems:**
   - Fix the `trim` bug.
   - Find the source of the SMS surge and add throttling.
   - Find out what happens after a second 429 retry, since the logs don't show whether those messages were delivered.
5. **Improve the release process:** add a canary check on pool metrics. This release went out at peak load during an active SMS alert, and it took 45 minutes to roll back, so also add a rollback trigger.

I didn't change anything in the project folder. The only files I created were temporary analysis scripts in the session scratchpad.

---

# Part 2: RCA on the `docs/rca.md` template (answer to prompt 2)

# RCA: інцидент 2026-10-14

## Коротко

For 45 minutes (14:02–14:47 Kyiv time), users of «Поштомат громади» got slow responses, and about 10.6% of API requests failed with 503. Release 1.8.0 left the API with an effective limit of 4 DB connections, so requests queued for the pool and timed out after 2 seconds. Rolling back to 1.7.3 ended the failures at once. These files can't show which change in 1.8.0 caused it.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 13:28 | First SMS 429s; SMS volume rises from about 15 to about 185 messages/min | Evidence #16, #17 |
| 13:37 | `SmsProvider429RateHigh` fires (warning); the API stays healthy | Evidence #3, #4 |
| 14:01:58 | API receives SIGTERM; the worker follows at 14:01:59 | Evidence #1, #2 |
| 14:02:00 | API 1.8.0 starts; `db_pool_in_use` is 4 from this minute | Evidence #1, #5 |
| 14:02:07 | First 503 `db pool wait timeout after 2000ms` | Evidence #8 |
| 14:02:07 | Worker 1.8.0 logs its start | Evidence #2 |
| 14:06 | `ApiLatencyP95High` fires (page) | Evidence #3 |
| 14:07 | `Api5xxRateHigh` fires (page) | Evidence #3 |
| 14:20:31 | API restarts, still on 1.8.0, and the worker is not restarted; one minute of partial relief, then the same failure | Evidence #1, #2, #11 |
| 14:46:58 | Last 503, and API receives SIGTERM | Evidence #1, #8 |
| 14:47:00 | API 1.7.3 starts, and the worker 1.7.3 follows at 14:47:01; no 503s after this | Evidence #1, #2, #10 |
| 14:48 | Latency and 5xx alerts resolve | Evidence #3 |
| 15:01 | Last minute with SMS 429s; the alert resolves at 15:03 | Evidence #3, #16 |

## Першопричина

**Proven by these files:**

1. **What changed:** release 1.8.0 replaced 1.7.3 at 14:02:00 (#1, #2).
2. **What became different:** `db_pool_in_use` was exactly 4 in all 45 minutes on 1.8.0. On 1.7.3 it reached 14 (#4, #5), and requests began waiting for a connection, with up to 23 waiting at once (#4).
3. **Why users saw this symptom:** a request waits for a connection for at most 2 seconds. Requests that got one in time were slow, with a mean of 1,858 ms against 73.5 ms on 1.7.3 (#12). Those that didn't got a 503, and all 3,380 503s carry that one error (#6, #7). They hit all three endpoints (#9) and make up 10.6% of requests in the window (#9b).
4. **Why it recovered at that moment:** the rollback to 1.7.3 at 14:47:00 restored pool use above 4, and no 503 appears after it (#4, #10). Restarting the API on the same version at 14:20:31 did not help (#11).

**Not proven by these files:** the defect inside 1.8.0. Candidates are a lowered pool setting, a default that took effect, longer connection holds or several acquisitions per request. Either way, a limit of 4 alone doesn't explain the overload (#14), so a second factor or a misleading metric is likely. The diff was deliberately not read in this run.

## Докази

Every command uses only `grep` and `awk`, has no pipes and runs from the repo root. Results are exact output. They were run with macOS `awk` and `grep`, not in Git Bash, so `gawk` is untested; the commands use only standard features.

Phases in #4: `1` is 1.7.3 before the SMS surge, `2` is 1.7.3 during the surge, `3` is 1.8.0, `4` is 1.7.3 during the surge, and `5` is 1.7.3 after it.

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | API version changes: 1.8.0 at 14:02:00, a restart on 1.8.0 at 14:20:31, 1.7.3 at 14:47:00 | `grep -e 'shutting down' -e 'service started' incident/logs/api-2026-10-14.jsonl` | `{"ts":"2026-10-14T14:01:58.214+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}`<br>`{"ts":"2026-10-14T14:02:00.087+03:00","level":"info","msg":"service started","version":"1.8.0"}`<br>`{"ts":"2026-10-14T14:20:29.530+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}`<br>`{"ts":"2026-10-14T14:20:31.112+03:00","level":"info","msg":"service started","version":"1.8.0"}`<br>`{"ts":"2026-10-14T14:46:58.401+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}`<br>`{"ts":"2026-10-14T14:47:00.236+03:00","level":"info","msg":"service started","version":"1.7.3"}` |
| 2 | The worker changed version with the API, and was not restarted at 14:20 | `grep -e 'shutting down' -e 'worker started' incident/logs/worker-2026-10-14.jsonl` | `{"ts":"2026-10-14T14:01:59.032+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}`<br>`{"ts":"2026-10-14T14:02:07.013+03:00","level":"info","msg":"worker started","version":"1.8.0"}`<br>`{"ts":"2026-10-14T14:46:59.118+03:00","level":"info","msg":"shutting down","signal":"SIGTERM"}`<br>`{"ts":"2026-10-14T14:47:01.305+03:00","level":"info","msg":"worker started","version":"1.7.3"}` |
| 3 | Alert order: SMS warning first, then the two pages | `grep -e '"name"' -e 'fired_at' -e 'resolved_at' incident/alerts.json` | `"name": "SmsProvider429RateHigh",`<br>`"fired_at": "2026-10-14T13:37:00+03:00",`<br>`"resolved_at": "2026-10-14T15:03:00+03:00",`<br>`"name": "ApiLatencyP95High",`<br>`"fired_at": "2026-10-14T14:06:00+03:00",`<br>`"resolved_at": "2026-10-14T14:48:00+03:00",`<br>`"name": "Api5xxRateHigh",`<br>`"fired_at": "2026-10-14T14:07:00+03:00",`<br>`"resolved_at": "2026-10-14T14:48:00+03:00",` |
| 4 | At the same load and SMS 429 level, only 1.8.0 (phase 3) shows pool waiting and high p95 | `awk -F, 'NR>1 { t=substr($1,12,5); p=(t<"13:28")?"1_12:00-13:28":(t<"14:02")?"2_13:28-14:02":(t<"14:47")?"3_14:02-14:47":(t<"15:02")?"4_14:47-15:02":"5_15:02-16:00"; n[p]++; r[p]+=$2; l[p]+=$3; e[p]+=$4; s[p]+=$8; if (!(p in a)) { a[p]=$5; b[p]=$5 } if ($5<a[p]) a[p]=$5; if ($5>b[p]) b[p]=$5; if ($6>w[p]) w[p]=$6; if ($7>h[p]) h[p]=$7 } END { m=split("1_12:00-13:28 2_13:28-14:02 3_14:02-14:47 4_14:47-15:02 5_15:02-16:00",P," "); for (i=1;i<=m;i++) { p=P[i]; printf "%s min=%d rps=%.1f p95=%.0f err=%.2f%% in_use=%d-%d wait_max=%d heap_max=%d sms429=%.1f\n", p, n[p], r[p]/n[p], l[p]/n[p], 100*e[p]/n[p], a[p], b[p], w[p]+0, h[p], s[p]/n[p] } }' incident/metrics/2026-10-14.csv` | `1_12:00-13:28 min=88 rps=5.8 p95=172 err=0.02% in_use=2-11 wait_max=0 heap_max=82 sms429=0.0`<br>`2_13:28-14:02 min=34 rps=11.5 p95=236 err=0.19% in_use=10-13 wait_max=0 heap_max=81 sms429=30.8`<br>`3_14:02-14:47 min=45 rps=11.8 p95=4476 err=10.74% in_use=4-4 wait_max=23 heap_max=82 sms429=34.8`<br>`4_14:47-15:02 min=15 rps=10.9 p95=254 err=0.15% in_use=9-14 wait_max=0 heap_max=82 sms429=30.1`<br>`5_15:02-16:00 min=58 rps=6.3 p95=178 err=0.04% in_use=2-10 wait_max=0 heap_max=82 sms429=0.0` |
| 5 | Pool use was exactly 4 in every 1.8.0 minute | `awk -F, 'NR>1 { t=substr($1,12,5); if (t>="14:02" && t<"14:47") { n++; if ($5==4) k++ } else if ($5>4) o++; else q++ } END { print "1.8.0_minutes=" n, "in_use_eq_4=" k, "other_minutes_above_4=" o, "other_minutes_at_most_4=" q }' incident/metrics/2026-10-14.csv` | `1.8.0_minutes=45 in_use_eq_4=45 other_minutes_above_4=115 other_minutes_at_most_4=80` |
| 6 | Number of pool timeouts | `grep -c 'db pool wait timeout after 2000ms' incident/logs/api-2026-10-14.jsonl` | `3380` |
| 7 | Number of 503s, the same as #6 | `grep -c '"status":503' incident/logs/api-2026-10-14.jsonl` | `3380` |
| 8 | 503s occur only while 1.8.0 runs | `awk '/"status":503/ { t=substr($0,19,12); if (!f) f=t; l=t } END { print "first=" f, "last=" l }' incident/logs/api-2026-10-14.jsonl` | `first=14:02:07.172 last=14:46:58.204` |
| 9 | Pool timeouts hit all three endpoints | `awk '/db pool wait timeout/ { p=$0; sub(/.*"path":"/,"",p); sub(/".*/,"",p); c[p]++ } END { print "/pickup=" c["/pickup"], "/parcels=" c["/parcels"], "/admin/parcels=" c["/admin/parcels"] }' incident/logs/api-2026-10-14.jsonl` | `/pickup=2586 /parcels=650 /admin/parcels=144` |
| 9b | 503s are 10.6% of requests in the window (assumes `rps` is the true rate) | `awk -F, 'FILENAME ~ /metrics/ { t=substr($1,12,5); if (FNR>1 && t>="14:02" && t<"14:47") r+=$2*60; next } /"status":503/ { n++ } END { printf "requests=%.0f 503=%d share=%.1f%%\n", r, n, 100*n/r }' incident/metrics/2026-10-14.csv incident/logs/api-2026-10-14.jsonl` | `requests=31866 503=3380 share=10.6%` |
| 10 | No 503s after the rollback | `awk '/"status":503/ && substr($0,19,8)>="14:47:00" { c++ } END { print c+0 }' incident/logs/api-2026-10-14.jsonl` | `0` |
| 11 | Restarting on 1.8.0 at 14:20:31 gave only one minute of partial relief, and in-use stayed at 4 | `awk -F, 'NR>1 && substr($1,12,5)>="14:19" && substr($1,12,5)<="14:22" { print substr($1,12,5), "p95=" $3, "err=" $4, "in_use=" $5, "wait=" $6, "heap=" $7 }' incident/metrics/2026-10-14.csv` | `14:19 p95=4594 err=0.1233 in_use=4 wait=23 heap=81`<br>`14:20 p95=3270 err=0.0676 in_use=4 wait=6 heap=43`<br>`14:21 p95=4588 err=0.1068 in_use=4 wait=20 heap=42`<br>`14:22 p95=4708 err=0.1201 in_use=4 wait=19 heap=49` |
| 12 | Mean latency of logged 200, 201 and 404 responses rose about 25 times | `awk '/"msg":"request"/ { t=substr($0,19,5); s=$0; sub(/.*"status":/,"",s); sub(/,.*/,"",s); m=$0; sub(/.*"ms":/,"",m); sub(/}.*/,"",m); v=(t>="14:02" && t<"14:47")?"1.8.0":"1.7.3"; if (s!=400 && s!=403) { n[v]++; x[v]+=m } } END { printf "1.7.3 n=%d mean=%.1fms; 1.8.0 n=%d mean=%.1fms\n", n["1.7.3"], x["1.7.3"]/n["1.7.3"], n["1.8.0"], x["1.8.0"]/n["1.8.0"] }' incident/logs/api-2026-10-14.jsonl` | `1.7.3 n=841 mean=73.5ms; 1.8.0 n=276 mean=1858.0ms` |
| 13 | During 1.8.0, responses that return before any visible DB wait stayed fast, so the process itself was healthy | `awk 'substr($0,19,5)>="14:02" && substr($0,19,5)<"14:47" { s=$0; sub(/.*"status":/,"",s); sub(/,.*/,"",s); if (s!=400 && s!=500) next; m=$0; sub(/.*"ms":/,"",m); sub(/[,}].*/,"",m); n[s]++; if (m+0>x[s]) x[s]=m+0 } END { print "400: n=" n[400], "max_ms=" x[400]; print "500: n=" n[500], "max_ms=" x[500] }' incident/logs/api-2026-10-14.jsonl` | `400: n=5 max_ms=6`<br>`500: n=52 max_ms=14` |
| 14 | A limit of 4 alone doesn't explain the overload: at 73.5 ms per request, 4 connections could serve about 54 rps, while the observed throughput implies 0.38 s per request (uses the mean from #12) | `awk -F, 'NR>1 { t=substr($1,12,5); if (t>="14:02" && t<"14:47") { o+=$2*(1-$4); k++ } } END { r=o/k; printf "ok_rps=%.2f implied_hold=%.2fs capacity_at_73.5ms=%.0f_rps\n", r, 4/r, 4/0.0735 }' incident/metrics/2026-10-14.csv` | `ok_rps=10.53 implied_hold=0.38s capacity_at_73.5ms=54_rps` |
| 15 | Many `/pickup` 503s took well over the 2-second wait, while `/parcels` 503s did not, which suggests `/pickup` makes several acquisitions per request | `awk '/"status":503/ { p=$0; sub(/.*"path":"/,"",p); sub(/".*/,"",p); m=$0; sub(/.*"ms":/,"",m); sub(/[,}].*/,"",m); n[p]++; if (m+0>=2500) l[p]++; if (m+0>x[p]) x[p]=m+0 } END { print "/pickup n=" n["/pickup"], "ge2500=" l["/pickup"]+0, "max=" x["/pickup"]; print "/parcels n=" n["/parcels"], "ge2500=" l["/parcels"]+0, "max=" x["/parcels"] }' incident/logs/api-2026-10-14.jsonl` | `/pickup n=2586 ge2500=1009 max=5607`<br>`/parcels n=650 ge2500=0 max=2008` |
| 16 | SMS 429s span 13:28–15:01 and overlap the outage. Outside it, the same 429s came with no pool waiting | `awk -F, 'NR>1 && $8>0 { t=substr($1,12,5); if (!f) f=t; l=t; if (t>="14:02" && t<"14:47") i++; else { o++; if ($6>w) w=$6; if ($3>p) p=$3 } } END { print "429_first=" f, "429_last=" l, "minutes_during_1.8.0=" i, "minutes_outside_1.8.0=" o, "outside_wait_max=" w+0, "outside_p95_max=" p }' incident/metrics/2026-10-14.csv` | `429_first=13:28 429_last=15:01 minutes_during_1.8.0=45 minutes_outside_1.8.0=49 outside_wait_max=0 outside_p95_max=618` |
| 17 | SMS volume rose about 12 times from 13:28 and fell back about 15:02. The 618 ms in #16 is the first minute after the rollback (#4 phase 4) | `awk '/sms batch sent/ { t=substr($0,19,5); c=$0; sub(/.*"count":/,"",c); sub(/}.*/,"",c); p=(t<"13:28")?1:(t<"14:47")?2:(t<"15:02")?3:4; s[p]+=c; if (c+0>x[p]) x[p]=c+0 } END { printf "12:00-13:28 %.1f/min max=%d; 13:28-14:47 %.1f/min max=%d; 14:47-15:02 %.1f/min max=%d; 15:02-16:00 %.1f/min max=%d\n", s[1]/88, x[1], s[2]/79, x[2], s[3]/15, x[3], s[4]/58, x[4] }' incident/logs/worker-2026-10-14.jsonl` | `12:00-13:28 15.5/min max=10; 13:28-14:47 184.5/min max=50; 14:47-15:02 169.1/min max=50; 15:02-16:00 17.2/min max=9` |
| 18 | Logs keep about 1% of non-5xx requests and all 5xx. This is inferred from the counts, not documented | `awk -F, 'FILENAME ~ /metrics/ { if (FNR>1) { r+=$2*60*(1-$4); e+=$2*60*$4 } next } /"msg":"request"/ { n++ } /"status":5[0-9][0-9]/ { x++ } END { printf "non5xx_expected=%.0f logged=%d ratio=%.2f%%; 5xx_expected=%.0f logged=%d\n", r, n, 100*n/r, e, x }' incident/metrics/2026-10-14.csv incident/logs/api-2026-10-14.jsonl` | `non5xx_expected=114503 logged=1143 ratio=1.00%; 5xx_expected=3505 logged=3505` |

## Що з даних НЕ є причиною — і чим це доведено

Кожна причина, яку назвав хоч один прогін AI і яку ви відкинули, і те, що підозрювали ви самі.

This table covers the hypotheses from this AI run only. The participant's own suspicions and anything from `rca-v2` are not recorded here, so they still need adding in `docs/rca.md`.

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS provider 429s or retries overloaded the service | It was the first alert, 29 minutes before the pages, and it overlaps the whole outage | For 49 minutes with 429s outside 1.8.0, pool waiting stayed at 0 and p95 never passed 618 ms: `awk -F, 'NR>1 && $8>0 { t=substr($1,12,5); if (!f) f=t; l=t; if (t>="14:02" && t<"14:47") i++; else { o++; if ($6>w) w=$6; if ($3>p) p=$3 } } END { print "429_first=" f, "429_last=" l, "minutes_during_1.8.0=" i, "minutes_outside_1.8.0=" o, "outside_wait_max=" w+0, "outside_p95_max=" p }' incident/metrics/2026-10-14.csv` → `429_first=13:28 429_last=15:01 minutes_during_1.8.0=45 minutes_outside_1.8.0=49 outside_wait_max=0 outside_p95_max=618` |
| A traffic spike | rps nearly tripled between 12:00 and 13:30, from about 4 to about 11, shortly before the outage | Peak rps during the outage matches the rest of the day, and evidence #4 shows the same load was healthy on 1.7.3: `awk -F, 'NR>1 { t=substr($1,12,5); v=(t>="14:02" && t<"14:47")?"in":"out"; if ($2>r[v]) r[v]=$2 } END { print "rps_max_during_1.8.0=" r["in"], "rps_max_rest_of_day=" r["out"] }' incident/metrics/2026-10-14.csv` → `rps_max_during_1.8.0=12.8 rps_max_rest_of_day=12.7` |
| Memory pressure or a heap leak | The API logs `heap usage high` warnings, and heap reaches 82% | Peak heap is identical during and outside the outage: `awk -F, 'NR>1 { t=substr($1,12,5); v=(t>="14:02" && t<"14:47")?"in":"out"; if ($7>h[v]) h[v]=$7 } END { print "heap_max_during_1.8.0=" h["in"], "heap_max_rest_of_day=" h["out"] }' incident/metrics/2026-10-14.csv` → `heap_max_during_1.8.0=82 heap_max_rest_of_day=82`<br>Warnings don't cluster in the outage hour: `awk '/heap usage high/ { c[substr($0,19,2)]++ } END { print "12h=" c["12"], "13h=" c["13"], "14h=" c["14"], "15h=" c["15"] }' incident/logs/api-2026-10-14.jsonl` → `12h=18 13h=16 14h=14 15h=15` |
| The `trim` TypeError on `/parcels` caused the 5xx alert | It is a real code error returning 500, and it occurs during the outage | Only 125 cases, on both versions, starting before the release: `awk '/reading .trim/ { t=substr($0,19,12); if (!f) f=t; l=t; n++; if (t<"14:02") a++; else if (t<"14:47") b++; else c++ } END { print "n=" n, "first=" f, "last=" l, "before_1.8.0=" a, "during_1.8.0=" b, "after_rollback=" c }' incident/logs/api-2026-10-14.jsonl` → `n=125 first=12:39:18.045 last=15:57:08.367 before_1.8.0=51 during_1.8.0=52 after_rollback=22`<br>Its share of estimated creates (logged 201 × 100, per #18) stays flat across all five phases: `awk '/"path":"\/parcels"/ { t=substr($0,19,5); p=(t<"13:28")?1:(t<"14:02")?2:(t<"14:47")?3:(t<"15:02")?4:5; if ($0 ~ /"status":201/) o[p]++; if ($0 ~ /"status":500/) e[p]++ } END { for (i=1;i<=5;i++) printf "phase%d 500=%d 201_logged=%d share=%.2f%%\n", i, e[i], o[i], 100*e[i]/(o[i]*100) }' incident/logs/api-2026-10-14.jsonl` → `phase1 500=6 201_logged=11 share=0.55%`<br>`phase2 500=45 201_logged=62 share=0.73%`<br>`phase3 500=52 201_logged=88 share=0.59%`<br>`phase4 500=15 201_logged=28 share=0.54%`<br>`phase5 500=7 201_logged=11 share=0.64%` |
| The TLS timeout to `sms.example.net` | It is an `error` line 20 seconds before the release, and it could suggest a network fault | It occurs once: `grep -c 'TLS handshake timeout' incident/logs/worker-2026-10-14.jsonl` → `1`<br>A batch was sent 2 seconds later: `awk 'substr($0,19,8)>="14:01:37" && substr($0,19,8)<"14:01:40" && !/rate limited/' incident/logs/worker-2026-10-14.jsonl` → `{"ts":"2026-10-14T14:01:37.954+03:00","level":"error","msg":"sms send failed","parcel_id":4898795,"error":"TLS handshake timeout to sms.example.net"}`<br>`{"ts":"2026-10-14T14:01:39.955+03:00","level":"info","msg":"sms batch sent","count":35}` |
| A stuck API process that a restart would clear | Someone tried this at 14:20, and it is a common first fix | Evidence #11: after the restart in-use stays at 4 and p95 returns to 4,588 ms within a minute |

**Less likely, but not refuted by these files:**

- **Connection leak in 1.8.0:** a leak usually climbs and recovers well after a restart, whereas here in-use is flat at 4 from the first minute and the restart barely helped (#5, #11). The slower build-up of 503s after 14:02 is unexplained, though, and could fit a leak.
- **The worker on 1.8.0 as the source:** it rolled back within a second of the API, so these files can't separate the two (#1, #2). Its sending never slowed, which points to the API (#17).
- **A DB-side problem:** there are no DB logs, so this can't be tested directly. It would have to start and end within seconds of both version changes.

## Чинники, що сприяли (contributing factors)

- **Release timing:** 1.8.0 went out at about twice the morning load (11.8 against 5.8 rps) and 25 minutes after an SMS warning fired (#3, #4). This probably increased the impact, but these files have no data on 1.8.0 at low load.
- **Slow recovery:** about 41 minutes passed between the first page at 14:06 and the rollback at 14:46:58, and the one recorded attempt before it, the 14:20 restart, kept the same version (#1, #3, #11). These files don't show why.
- **No saturation alert:** the three alerts cover only SMS 429s, p95 and error rate (#3). Pool waiting was already above 0 at 14:02, about 4 minutes before the first page: `awk -F, 'substr($1,12,5)=="14:02" { print "wait=" $6 }' incident/metrics/2026-10-14.csv` → `wait=4`
- **Gaps in observability:**
  - Only the 3 startup lines in the API log carry a version: `grep -c '"version"' incident/logs/api-2026-10-14.jsonl` → `3`
  - The metrics have no pool-limit column, so "4" has to be inferred from the plateau: `awk -F, 'NR==1' incident/metrics/2026-10-14.csv` → `ts,rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting,heap_used_pct,sms_429_per_min`
  - Only about 1% of successful requests are logged, so latency figures for them rest on small samples (#12, #18).

## Впевненість

| Conclusion | Confidence | Why |
|---|---|---|
| Release 1.8.0 triggered the incident | **High** | Onset and recovery both match the version changes, at the same load and SMS 429 level (#1, #4, #8, #10) |
| The mechanism was DB pool starvation | **High** | All 3,380 503s carry the pool timeout, in-use stays at 4 and requests wait (#4–#7) |
| The specific defect inside 1.8.0 | **Low** | These files have no diff, config or DB logs, and the arithmetic in #14 doesn't fit a lowered limit alone |

**Assumptions:**

- `db_pool_*` describes the API's pool.
- `rps` is the true request rate.
- The 1% log sampling inferred in #18 is real.
- `/pickup` making several acquisitions per request is an inference from #15.

**What's missing:** the 1.7.3 to 1.8.0 diff, the pool configuration, DB logs, and a definition of the `db_pool_*` metrics.

**What could change the conclusion:**

- A diff with no pool or query change would weaken the mechanism, and point to the environment or to something else deployed at the same time.
- Evidence that the metric covers more than the API's pool would change how "4" should be read.
- 1.7.3 also failing at this load in a test would undo the main comparison in #4.

## Перша відповідь AI проти другої

`rca-v2` doesn't exist yet, so that column is still empty. The "Збігається з вашою?" row is the participant's to fill in.

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | Release 1.8.0 left the API with an effective limit of 4 DB connections, which caused pool starvation. The specific defect wasn't identified | Not run yet |
| Впевненість, яку заявив AI | High for the release and the mechanism; low for the specific defect (about 50–60% for a lowered pool setting in Part 1) | Not run yet |
| Збігається з вашою? | To be filled in by the participant | To be filled in by the participant |
| Що в даних вплинуло на відповідь | — | Not run yet |
