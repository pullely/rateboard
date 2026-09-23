# rateboard-sponsor-pipeline — implementation plan

Milestones land in order. Each one is made of one or more tasks, each task is
one pull request, and each pull request is landed with `orun pr land`. A
milestone is marked ✅ here when its "done when" list is true, and it is
recorded in `IMPLEMENTATION-STATUS.md`.

A workspace can mint only 200 brokered credentials per rolling 24 hours, and
every CI job that deploys spends one. The bootstrap, this spec and RB1 fit into
one day. RB2 and RB3 land the next day. Each milestone's tests run green
locally before its pull request opens, because every push to a pull request
spends mints.

## RB0 — the spec

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic rateboard-sponsor-pipeline` shows them

## RB1 — the deal pipeline and the inventory calendar

This milestone builds the `deal` bounded context end to end:

- Migration `200_deal_core`: `deal_publications`, `deal_issues`, `deal_slots`,
  `deal_sponsors`, `deal_deals`, `deal_bookings` (with the partial unique index
  `uq_deal_bookings_live_slot`) and `deal_stage_history`, with CHECKs on every
  enum, on non-negative money, on `cpm_cents` when `pricing = 'cpm'`, and on
  `released_at` / `release_reason` together. The migration seeds nothing. If a
  later one does, every seed insert is `ON CONFLICT DO NOTHING`, because the
  SQLite schema test applies every migration twice.
- `packages/db/src/deal`: the repository. Every function takes `orgId`. Every
  write that the caller branches on uses `RETURNING` (runbook trap 22). The
  booking claim, the release and the stage move are single conditional
  statements (design §2, §3).
- `packages/contracts/src/deal.ts` (enums, the transition table, wire types)
  and the SDK `DealClient` (`client.deals`).
- `apps/deal-worker`: the routes of design §4.1, membership + policy on every
  route, audit events through the D1-portable events path. It depends on
  `db-migrate` (runbook trap 21), `membership-worker` and `policy-worker`.
- api-edge: the `deal` facade, the `DEAL_WORKER` binding and a `deal` rate-limit
  family. Policy: `deal.read` (all roles), `deal.write` (owner, admin,
  builder). `events-worker`: the `rbp_ rbi_ rbs_ rbn_ rbd_ rbb_` subject
  prefixes. Contracts: `deal-worker` on the notifications internal-actor
  allow-list (for RB2).
- Console: Pipeline, Deal, Inventory and Sponsors pages and their nav entries.
  Solo profile off.
- **Baseline fixes carried here** (runbook): the tested cirrus D1 patch
  (`cirrus-d1-fix.patch`, trap 16: `appendEventWithAudit`, membership org
  create and invitation accept, and the SQLite schema test harness), and a
  redeploy marker on every worker's `component.yaml` (trap 17), because
  `packages/db`, `packages/policy-engine` and `packages/contracts` change.
- `tests/deal-worker` over real SQLite: the HTTP flow, the state machine, the
  double-booking refusal including a concurrent race of many claims on one slot
  (exactly one 201), the release rules, the trap-22 pins, and tenant isolation.

**Done when**
- on stage a signed-in user creates an organization (201)
- they create a publication, an issue with two slots, and a sponsor, then create
  a deal and move it lead → pitched (and `booked` is refused with
  `409 no_bookings` before a slot is booked)
- they book a slot (201). A second deal booking the same slot is refused with
  `409 slot_already_booked`, and the calendar shows the slot held by the first
  deal
- the deal moves booked → delivered → paid, and the stage history lists every
  move
- a signed-in non-member gets 404 on the org's routes
- on prod `/health` answers 200, the routes answer 401 unauthenticated, and
  `DEBUG_DELIVERY` is off
- `tests/deal-worker` is green in CI, including the race test

## RB2 — insertion orders, proof of delivery and the sponsor report link

- Migration `210_deal_paperwork`: `deal_insertion_orders`, `deal_deliveries`,
  `deal_report_links` (design §1.8), with every write through `RETURNING`
  and the IO number claimed under `UNIQUE (org_id, seq)`.
- `deal-worker`: the routes of design §4.2. The `booked → delivered` rule now
  requires a delivery on every live booking. The `deal.io.sent` template goes
  in `notifications-worker`, and `deal-worker` gets the `NOTIFICATIONS_WORKER`
  binding and a `dependsOn` on it. `deal-worker` is already on the allow-list.
- api-edge: the public lane `GET /ingress/rateboard/r/{token}` (rate-limited per
  IP, no actor headers). Console: the IO, delivery and report-link panels, and
  the public `/r/[token]` page.

**Done when**
- on stage an IO is created for a booked deal, numbered `IO-0001`, and "send"
  returns 202 from notifications
- delivery is recorded on both bookings, and the deal moves booked → delivered
  only after the second one
- a report link is created. `GET /ingress/rateboard/r/{token}` with no session
  returns the delivered slots and stats and no price. After revocation it
  answers 404, like an unknown token.
- tests pin the IO numbering under a concurrent race, the delivery rule, and
  that the token is stored only as a hash

## RB3 — opt-in rate benchmarks

- Migration `220_bench_core`: `bench_contributions`, `bench_runs`,
  `bench_cells` (the published output, exactly the design §6.5 fields) and
  `bench_cell_contributors` (private, read by no route).
- `packages/db/src/bench`: `readContributedBookings`, the one cross-org read
  (design §6.3), and the snapshot writes.
- `apps/bench-worker`: the contribution routes, the read routes, and the
  weekly `scheduled()` aggregate (`0 4 * * 1`) with the k = 5 threshold,
  one value per contributor, rounding, contributor bands and change-by-one
  withholding. Policy: `bench.contribute` (owner, admin), `bench.read` (all
  roles, and the org must be contributing).
- Console: Settings → Benchmarks consent and the Benchmarks page.

**Done when**
- every test of design §6.7 passes in CI
- on stage (with fixture orgs seeded through the API) a cell with six eligible
  contributors publishes percentiles and a band. After one revocation the next
  run withholds it. A non-contributing org gets 404 from the read routes.
- README status `✅ Shipped` only after RB3's deploy run on `main` is fully green

## Sequencing

RB1 → RB2 → RB3. RB2 needs RB1's bookings. RB3 needs RB1's booking copies
(format, niche, audience size) and gains nothing from RB2, so RB3 could land
before RB2 if RB2 slips. RB3 must not land before RB1 has been in use long
enough to hold real bookings, and its 30-day eligibility rule means the first
real cells appear a month after the first opt-ins.
