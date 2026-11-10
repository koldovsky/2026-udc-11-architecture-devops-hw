- Інструмент і модель: Claude Code, Claude Opus 5.5
- Дата: 2026-11-04
- Що бачила сесія: тимчасова тека `ws11-b-code` з копією `app/`
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  >    рівень System Context і рівень Container.
  >    Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  >    припущення називай явно.

---

# Poshtomat: C4 diagrams

I built these from the code in `app/`, and where the docs disagreed, I followed the code. The exception is deployment and PostgreSQL, which only the docs describe. I couldn't test-render the diagrams because no Mermaid renderer is installed here, and Mermaid's C4 support is still experimental, so the layout may need adjusting.

## Level 1: System Context

```mermaid
C4Context
    title System Context: Poshtomat community parcel lockers

    Person(resident, "Resident", "Receives an SMS with a code and collects the parcel")
    Person(operator, "Delivery operator", "Puts parcels into locker cells")
    Person(staff, "Staff member", "Views the parcel list")

    System_Ext(terminal, "Locker terminal", "Screen on the locker where the code is entered")
    System_Ext(scanner, "Delivery scanner", "Device that registers a parcel")

    System(poshtomat, "Poshtomat", "Registers parcels, notifies recipients, handles pickups and sends uncollected parcels back")

    System_Ext(sms, "SMS provider", "Delivers text messages")
    System_Ext(courier, "Courier returns API", "Collects uncollected parcels and returns them to the sender")
    System_Ext(monitoring, "Monitoring", "Checks service health")

    Rel(resident, terminal, "Enters pickup code")
    Rel(operator, scanner, "Scans parcel")
    Rel(terminal, poshtomat, "Submits pickup code", "HTTP/JSON")
    Rel(scanner, poshtomat, "Registers parcel", "HTTP/JSON")
    Rel(staff, poshtomat, "Views parcels", "HTTP/JSON, Bearer session")
    Rel(monitoring, poshtomat, "Polls health", "HTTP")
    Rel(poshtomat, sms, "Sends pickup code message", "HTTP/JSON, Bearer token")
    Rel(sms, resident, "Delivers SMS with code", "SMS")
    Rel(poshtomat, courier, "Requests parcel return", "HTTP/JSON")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Level 2: Container

```mermaid
C4Container
    title Container: Poshtomat

    Person(staff, "Staff member", "Views the parcel list")
    System_Ext(terminal, "Locker terminal", "Screen on the locker")
    System_Ext(scanner, "Delivery scanner", "Registers parcels")
    System_Ext(monitoring, "Monitoring", "Checks service health")

    System_Boundary(poshtomat, "Poshtomat") {
        Container(api, "API", "Node.js 22, node:http, Docker", "Registers parcels, handles pickups, serves the staff list and health check")
        Container(worker, "SMS worker", "Node.js 22, Docker", "Polls for unnotified parcels and sends arrival messages")
        Container(job, "Nightly expiry job", "Node.js 22, cron on the VM", "Finds parcels waiting over 72 hours and sends them back")
        ContainerDb(db, "PostgreSQL", "PostgreSQL, on the VM outside Docker", "Stores parcels, events and staff sessions")
    }

    System_Ext(sms, "SMS provider", "Delivers text messages")
    System_Ext(courier, "Courier returns API", "Collects and returns parcels")

    Rel(terminal, api, "POST /pickup", "HTTP/JSON, no auth in code")
    Rel(scanner, api, "POST /parcels", "HTTP/JSON, no auth in code")
    Rel(staff, api, "GET /admin/parcels", "HTTP/JSON, Bearer session")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Reads and writes parcels and events, reads sessions", "SQL, pool")
    Rel(worker, db, "Reads unnotified parcels, sets notifiedAt", "SQL, pool, every 10 s")
    Rel(job, db, "Reads expired parcels, marks them returned", "SQL, pool, nightly")

    Rel(worker, sms, "POST /messages, 5 per second by default, retries on 429", "HTTP/JSON, Bearer token")
    Rel(job, courier, "POST /returns", "HTTP/JSON, no auth in code")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Assumptions
1. **PostgreSQL is what runs in production:** this repo only has an in-memory store (`src/db.js`). It has no PostgreSQL driver, and `dbUrl` is loaded but never used. Run from this repo, the API, worker and job each get their own separate data.
2. **Deployment details are unverified:** one VM, `docker compose` and PostgreSQL outside the containers all come from `ARCHITECTURE.md`. The `deploy/` directory it points to isn't in this copy.
3. **The nightly job runs from cron on the VM:** a comment in `bin/expire-parcels.js` says so. I'm treating it as its own container, but whether it runs inside the Docker image is unknown.
4. **The locker terminal and scanner are external:** their code isn't in this repo, and only the API they call is. If your team owns the terminal software, it should move inside the system boundary.
5. **The delivery operator and courier API are separate:** they may be the same company, but the code doesn't say.
6. **Staff call the API directly:** the repo has no admin UI, so any client they use isn't shown.
7. **Traffic is plain HTTP:** the server has no TLS, and any reverse proxy would be defined outside this repo, so none is shown.
8. **Logs aren't shown:** services write JSON lines to stdout, and the repo doesn't show a log collector.

## Where the docs and code disagree
`ARCHITECTURE.md` says it describes v1.5, while `package.json` is at 1.7.3.

| Topic | `ARCHITECTURE.md` | Code (used in the diagrams) |
|---|---|---|
| Worker polling | Every 30 seconds | Every 10 seconds, and immediately after a full batch of 50 |
| Pickup code | 4 digits | 6 digits |
| Nightly job | Marks parcels as returned | Also calls the courier API, an external system missing from the docs |

## Gaps worth checking
- **No auth on device endpoints:** `POST /parcels` and `POST /pickup` have no authentication in the code. Unless something outside this repo restricts them, anyone who can reach the API can call them.
- **Staff session origin:** nothing in the app creates sessions, and there's no login endpoint; only the tests add them. Whatever issues them is missing from both diagrams.
