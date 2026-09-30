# rateboard-sponsor-pipeline (RB) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| RB0 — the spec | ✅ merged 4f2e279, pushed with `orun spec push` | #9 |
| RB1 — the deal pipeline and the inventory calendar | ✅ merged 01912e3; `main` deploy run 35935783407 green 66/66; stage smoke green (org 201, double-booking 409, burst of 6 → one 201), prod 401s and `DEBUG_DELIVERY` off | #10 |
| RB2 — insertion orders, proof of delivery and the sponsor report link | ✅ merged a58ccee; `main` deploy run 36657548641 green 60/60 (dev 21, stage 19, prod 19, plan 1); stage smoke green (IO-0001…IO-0006 under a burst of 6, delivered refused 2→1→allowed, report link 200 with no login, unknown/malformed/revoked/expired → identical 404, IO email 202 accepted), prod 401 on all 8 routes, `DEBUG_DELIVERY` off | #11 |
| RB3 — opt-in rate benchmarks | In review | this PR |

## Departures from the design

### RB1

- **Baseline fixes carried (runbook trap 16, trap 17).** RB1 applies the
  portfolio's tested `cirrus-d1-fix.patch`: the baseline's
  `appendEventWithAudit` and the membership org-create and invitation-accept
  SQL are Postgres-only and fail on D1, so organization create answered 503.
  The patch also adds the SQLite schema test harness. Every worker's
  `component.yaml` carries a redeploy marker, because `packages/db`,
  `packages/policy-engine` and `packages/contracts` changed and a worker
  redeploys only when its own `component.yaml` does.
- **deal-worker writes audit rows with portable SQL** (`appendEvent` +
  `INSERT … SELECT`), not the patched `appendEventWithAudit`, so it does not
  depend on the patch. This is best-effort after the write commits (RB-I).
- **Additions not spelled out in design §4.1:** `409 duplicate_name` for a
  publication, sponsor, issue title or slot label that already exists (per
  org, per publication or per issue, case-insensitive). A create inserts with
  `ON CONFLICT DO NOTHING` and a rename uses `UPDATE OR IGNORE`, so the outcome
  is read from `RETURNING` rather than from an exception. Booking a slot that
  has no list price, without a `priceCents`, is `422`. `409 already_released`
  answers a second release of the same booking.
- **Not built in RB1:** editing or cancelling an issue (`PATCH issues/{rbi}`).
  The claim already refuses cancelled issues, but no route sets `cancelled`
  yet. It goes with RB2's delivery work.

### RB2

- **The IO email is "accepted", not "delivered" (runbook trap 27).** `POST
  …/insertion-order/send` answers `202` with `notification.status =
  "accepted"` once notifications-worker takes the send. No product domain is
  held, so Cloudflare Email refuses the actual delivery on every environment;
  the IO is recorded as `sent` on acceptance.
- **Re-sending is allowed.** The IO carries a `send_count`; each send uses the
  idempotency key `deal.io.sent:<rbo>:<n>`, so a retried request collapses to
  one email while a deliberate re-send is a new one. A signed IO is frozen:
  edits and sends answer `409 insertion_order_signed`.
- **deal-worker posts to notifications with a 40-line client of its own**
  (`src/notify.ts`) rather than depending on `@saas/notifications-client`, so
  the lockfile does not change. Same headers (`x-internal-actor: deal-worker`)
  and the same V1 enqueue contract.
- **IO numbering.** The number is claimed inside the INSERT
  (`COALESCE(MAX(seq), 0) + 1` under `UNIQUE (org_id, seq)`), with one retry
  when nothing is inserted and the deal is still issuable. An IO can be drawn
  up once the deal is `booked` (or later): `409 deal_not_booked` before that,
  `409 insertion_order_exists` for a second one. Its total defaults to the sum
  of the live bookings, in the deal's currency.
- **Deliveries** can be recorded only on a live booking of a deal that is
  `booked` or later (`409 deal_not_booked`, `409 already_released`). `PUT`
  replaces. `booked → delivered` needs at least one live booking AND a
  delivery on every live booking, both inside the conditional `UPDATE`
  (`409 undelivered_bookings`, with the count).
- **Report links** take `expiresInDays` (1–365, or none) instead of an
  absolute `expiresAt`, and count views (`view_count`) as well as stamping
  `last_viewed_at`. A second live link is `409 report_link_exists`; a revoked
  link cannot be revived (`409 already_revoked`), a new one is created instead.
  The public lane answers `404 {code: not_found, message: "Not found"}` for a
  malformed, unknown, revoked or expired token alike, with `cache-control:
  no-store`. The console renders the report at `/r/[token]` by calling the API
  lane from the browser.
- **`PATCH issues/{rbi}`** (the RB1 departure) is built: title, publish date
  and status. Cancelling is refused inside the same `UPDATE` while a slot of
  the issue has a live booking (`409 issue_has_bookings`).

### RB3

- **Stage-only overrides (recorded departures; neither is in prod).** Stage
  sets `BENCH_MIN_OPTIN_DAYS=0` and runs the aggregate every 5 minutes
  (`*/5 * * * *`), because stage cannot reach k = 5 eligible contributors
  under a 30-day opt-in age, or show a publish and then a withhold, on the day
  RB3 ships. Prod has neither: its vars are `ENVIRONMENT` only and its cron is
  `0 4 * * 1`. The code also ignores the override whenever `ENVIRONMENT` is
  `prod` (`apps/bench-worker/src/config.ts`, pinned by a test that reads the
  wrangler template).
- **The change-by-one rule is checked against EVERY published version of a
  cell, not only the last one.** §6.6 compares with the last published set,
  but §6.7's property test requires that *no two* published versions differ by
  exactly one org, and the last-only rule fails it (publish S, then S + {a, b},
  then S − {d}: S and S − {d} differ by one). So `bench_cell_contributors`
  keeps the member set of every published version (it is not pruned to the
  latest snapshot).
- **Members are SHA-256 pseudonyms, and revocation does not delete them.**
  §6.3 says the private records holding a revoker's id are deleted. They never
  hold the id: each member is `SHA-256("rateboard-bench-member:" + org id)`.
  Deleting a revoker's pseudonym would make an earlier published version look
  as if the revoker had never been in it, so a later version could then differ
  from it by exactly the revoker — the attack the rule exists to stop.
  Revocation still stops every read of the org's rows at once (the consent join
  is inside `readContributedBookings`) and removes it from every future value.
- **Snapshot labels.** A run's `snapshot` is its ISO week (`2026-W40`); a
  second run in the same week is `2026-W40.2`, and so on (claimed under
  `UNIQUE (snapshot)`). Reads serve the latest run marked `done`; cells of older
  snapshots are pruned after a run completes, and a failed run leaves the
  previous snapshot serving.
- **Qualifying bookings** are live, USD, of a booked/delivered/paid deal booked
  in the last 365 days, with a niche and format other than `other` and an
  audience above 0 (the CPM divides by it). Each org is judged eligible on its
  own (30 days, ≥ 3 qualifying bookings); eligible orgs sharing an owner or
  admin are then merged, and a merged contributor's value in a cell is the
  median of the pooled bookings.
- **Owners and admins are read from the membership tables in the shared D1**
  (`readOrgAdmins`), as expirio reads owners, not through a membership-worker
  route (none offers it). Subject ids are compared after normalising
  `usr_<hex>` to the UUID form (runbook trap 39); a test mixes both forms.
- **`bench.read` goes to owner, admin, builder and viewer**, like `deal.read`
  (not `billing_admin`). A non-contributing org gets 404 on the read routes
  before any query validation.
- **The consent switch lives on the Benchmarks page** (with the exact list of
  what is shared), not under Settings → Benchmarks. `PUT` answers 201 for a new
  consent and 200 when the org is already contributing.
- **The static boundary test (§6.7.8)** reads the repository interfaces:
  `readContributedBookings` is the only function over `deal_*` rows without an
  `orgId`, apart from RB2's `openReportLink`, which is keyed by a token hash and
  returns a single link's org and deal — the test names it as the one other
  exception.
- **Also fixed:** the inventory's slot order was `created_at, id`, so two
  slots created in the same millisecond came back in random order (an RB1 test
  flaked on it). It is now `created_at, rowid`.
