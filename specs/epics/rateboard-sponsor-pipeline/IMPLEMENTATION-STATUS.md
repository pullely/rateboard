# rateboard-sponsor-pipeline (RB) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| RB0 — the spec | ✅ merged 4f2e279, pushed with `orun spec push` | #9 |
| RB1 — the deal pipeline and the inventory calendar | ✅ merged 01912e3; `main` deploy run 35935783407 green 66/66; stage smoke green (org 201, double-booking 409, burst of 6 → one 201), prod 401s and `DEBUG_DELIVERY` off | #10 |
| RB2 — insertion orders, proof of delivery and the sponsor report link | In review | this PR |
| RB3 — opt-in rate benchmarks | | |

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
