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
