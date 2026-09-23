# rateboard-sponsor-pipeline — design

This document covers the whole epic. §1–§5 describe the tenant-scoped product
(RB1, RB2). §6 describes the one place Rateboard reads across tenants (RB3),
and it is written as a security design: a threat model, the controls, and the
tests that prove them. It is written now, before RB1 is built, because RB1's
schema decides what RB3 can and cannot learn.

Conventions, as in the rest of the baseline: public ids are
`<prefix>_<32 hex>` over a UUID; money is integer minor units plus an ISO 4217
code; dates are `YYYY-MM-DD` strings and timestamps ISO-8601 UTC strings (D1
stores TEXT, and a string comparison of two such values is a date
comparison); every response is the `{ data, meta }` or `{ error }` envelope;
every route is org-scoped and answers **404, not 403**, to a caller who is not
a member, so a non-member cannot probe whether anything exists.

## 1. The resources

One bounded context, `deal`, owned by `apps/deal-worker`, in migration
`200_deal_core` (RB1) and `210_deal_paperwork` (RB2). Every table carries
`org_id`, and every repository function takes `orgId` as its first argument
and puts it in the `WHERE` clause. The only code that reads `deal_*` rows
without an org filter is the RB3 aggregate (§6), and it lives in a different
context and a different worker.

### 1.1 Publications: `rbp_` (RB1)

A newsletter or a podcast the organization sells sponsorships in.

| Field | Notes |
|---|---|
| `name` | unique per org, case-insensitive |
| `kind` | `newsletter` \| `podcast` |
| `niche` | one of a fixed list: `tech`, `business`, `finance`, `marketing`, `health`, `food`, `travel`, `parenting`, `education`, `news_politics`, `science`, `gaming`, `lifestyle`, `crypto`, `careers`, `other`. It is a fixed list, not free text, because RB3's cells must be bounded and free text identifies people (§6.4) |
| `audienceSize` | subscribers (newsletter) or average downloads per episode (podcast), entered by hand, 0–100,000,000 |
| `platform` | optional: `beehiiv`, `substack`, `convertkit`, `ghost`, `spotify`, `apple`, `other` |
| `currency` | the default currency for slot prices, ISO 4217 |
| `status` | `active` \| `archived` |

### 1.2 Issues and episodes: `rbi_` (RB1)

One dated issue of a newsletter or episode of a podcast: `publicationId`,
`title` (unique within the publication, e.g. "Issue #142" or "Ep. 88"),
`publishOn` (date), `status` `scheduled` \| `published` \| `cancelled`. A
booking cannot be made into a cancelled issue's slots.

### 1.3 Ad slots: `rbs_` (RB1)

A sellable position in one issue: `issueId`, `label` (unique within the
issue: "Primary", "Mid-roll 1"), `format`, `listPriceCents` (optional) and
`currency`. Formats are a fixed list. For newsletters: `nl_primary`,
`nl_secondary`, `nl_classified`, `nl_dedicated`. For podcasts: `pod_preroll`,
`pod_midroll`, `pod_postroll`. For anything else: `other`. A slot's format must
match its publication's kind (`other` fits both).

### 1.4 Sponsors: `rbn_` (RB1)

A company that buys: `name` (unique per org, case-insensitive), `website`,
`contactName`, `contactEmail`, `notes`.

### 1.5 Deals: `rbd_` (RB1)

One sale to one sponsor: `sponsorId`, `title`, `stage`, `valueCents`
(optional, the agreed total), `currency`, `pricing` `flat` \| `cpm`,
`cpmCents` (required when `pricing = cpm`), `notes`, `stageChangedAt`. A deal
is created at `lead`. The stage changes only through the state machine in §3,
never through `PATCH`.

### 1.6 Bookings: `rbb_` (RB1)

A deal's claim on one slot: `dealId`, `slotId`, `priceCents` (defaults to the
slot's list price, required if the slot has none), `currency`, and three
values **copied at booking time**: the slot's `format`, and the publication's
`niche` and `audienceSize`. The copies keep a deal's history true when a
publication is later edited, and they are what RB3 aggregates (§6.3). A booking
is *live* until `releasedAt` is set. Released bookings are kept as history.

### 1.7 Stage history (RB1)

`deal_stage_history` records every transition (`fromStage`, `toStage`,
`changedBy`, `changedAt`), including creation (`null → lead`). It is shown on
the deal page. The audit trail records the same moves as events (§5).

### 1.8 RB2 resources

- **Insertion orders: `rbo_`.** One per deal (`UNIQUE (deal_id)`), created
  when the deal is `booked` or later. It is numbered per org (`IO-0001`),
  assigned with `INSERT … SELECT COALESCE(MAX(seq), 0) + 1 … RETURNING` under
  `UNIQUE (org_id, seq)`, with one retry on conflict. It records the terms
  (free text), the total and currency (defaulting to the sum of the live
  bookings), a payment-due date, and a `status` of `draft`, `sent` or
  `signed`. "Send" emails it to the sponsor contact through
  `notifications-worker`. "Signed" is recorded by hand. There is no
  e-signature provider.
- **Deliveries: `rbv_`.** One per booking (`UNIQUE (booking_id)`):
  `deliveredOn`, `proofUrl` (the live issue or episode URL), and hand-entered
  stats `opens`, `clicks`, `impressions`, `downloads` (each optional,
  non-negative integers), plus `notes`. From RB2 a deal moves `booked →
  delivered` only when every live booking has a delivery, and the conditional
  `UPDATE`'s `WHERE` checks this with `NOT EXISTS`.
- **Sponsor report links: `rbr_`.** A single-purpose, revocable, no-login
  link to one deal's delivery report, on the model of expirio's renewal link
  and arcdesk's status link. The token is 32 random bytes, base64url-encoded,
  and shown once. Only its SHA-256 is stored (`UNIQUE (token_sha256)`). A
  partial unique index `ON (deal_id) WHERE revoked_at IS NULL` allows one live
  link per deal. The link has an optional `expiresAt` and a `lastViewedAt`.
  The public lane (§4.2) answers the same 404 for an unknown, revoked or
  expired token. It returns only the report: sponsor name, the deal title, and
  each delivered slot's publication, issue, date, format, proof URL and stats.
  It never returns prices, notes, the IO, other deals or member identities.

## 2. The booking guarantee: a slot is booked at most once

The pitch's first promise is "nothing gets double-booked". A UI check ("this
slot looks free") followed by an insert is a race: two tabs, two teammates,
or a retried request can both pass the check. Rateboard therefore enforces it
in D1:

```sql
CREATE UNIQUE INDEX uq_deal_bookings_live_slot
  ON deal_bookings (slot_id) WHERE released_at IS NULL;
```

A booking is claimed in **one statement** that checks everything the claim
depends on and inserts only if all of it holds:

```sql
INSERT INTO deal_bookings (id, org_id, deal_id, slot_id, price_cents, currency,
                           format, niche, audience_size, booked_by, booked_at)
SELECT $id, d.org_id, d.id, s.id, COALESCE($price, s.list_price_cents), …
  FROM deal_deals d
  JOIN deal_slots s        ON s.id = $slot AND s.org_id = d.org_id
  JOIN deal_issues i       ON i.id = s.issue_id AND i.status <> 'cancelled'
  JOIN deal_publications p ON p.id = s.publication_id
 WHERE d.id = $deal AND d.org_id = $org
   AND d.stage IN ('lead', 'pitched', 'booked')
ON CONFLICT DO NOTHING
RETURNING id, …;
```

SQLite runs one statement at a time against one database, and D1 is SQLite,
so of any number of concurrent claims on one slot exactly one inserts. The
others hit the partial unique index and `DO NOTHING` returns no row. The
worker decides the outcome from the returned rows, never from `rowCount`,
which the D1 executor reports as 0 for any write without `RETURNING` (runbook
trap 22). When no row comes back, a follow-up read names the reason:

| Reason | Status | `error.details.reason` |
|---|---|---|
| the slot has a live booking | 409 | `slot_already_booked` (with the holding deal's id) |
| the deal is `delivered`, `paid` or `lost` | 409 | `deal_not_bookable` |
| the issue is cancelled | 409 | `issue_cancelled` |
| the deal or slot is not in this org | 404 | — |

The same deal booking the same slot again also answers `slot_already_booked`.
A retried request that carries the same `Idempotency-Key` replays the first
answer at api-edge (the baseline's idempotency layer) instead.

**Release** is one conditional `UPDATE … SET released_at … RETURNING`. It is
allowed while the deal is `lead` or `pitched`. While the deal is `booked` it is
allowed only if another live booking remains. The `WHERE` clause counts live
bookings, so two concurrent releases of a booked deal's last two bookings
cannot both succeed (`409 last_booking`). Moving a deal to `lost` releases all
its live bookings with `release_reason = 'deal_lost'`, which frees the slots.

## 3. The pipeline state machine

```
lead ──► pitched ──► booked ──► delivered ──► paid
  │         │          │
  └────►  lost  ◄──────┘          lost ──► lead   (reopen)
```

| From | Allowed to | Extra condition |
|---|---|---|
| `lead` | `pitched`, `lost` | |
| `pitched` | `booked`, `lost` | `booked` needs at least one live booking (`409 no_bookings`) |
| `booked` | `delivered`, `lost` | from RB2, `delivered` needs a delivery for every live booking (`409 undelivered_bookings`); `lost` releases the bookings |
| `delivered` | `paid` | |
| `lost` | `lead` | |
| `paid` | — | terminal |

`POST …/deals/{rbd}/stage` takes `{ "to": <stage>, "from": <stage>? }`. The
move is one conditional statement, `UPDATE deal_deals SET stage = $to,
stage_changed_at = $now … WHERE id = $deal AND org_id = $org AND stage = $from
[AND EXISTS (live booking)] RETURNING …`. `$from` is the caller's `from` if
given, otherwise the stage the worker just read. A transition not in the table
is `422 invalid_transition`. A lost race (the stage changed underneath) is
`409 stage_conflict` and includes the current stage. Every successful move
appends a `deal_stage_history` row and a `deal.stage.changed` audit event.

`booked` → `pitched` and other backward moves are deliberately absent. A
wrong booking is released while the deal is still `pitched`, or the deal is
lost and reopened. That keeps the history honest and keeps RB3's "a booked
deal is a real price" assumption true (§6.3).

## 4. The API

### 4.1 RB1: `deal-worker`, behind api-edge's `deal` facade

All under `/v1/organizations/{org}/`. Reads need `deal.read` (every role).
Writes need `deal.write` (owner, admin, builder).

| Route | Does |
|---|---|
| `GET publications` · `POST publications` | list (with `?status=`), create |
| `GET publications/{rbp}` · `PATCH publications/{rbp}` | read, edit (name, niche, audience size, platform, currency, status) |
| `POST publications/{rbp}/issues` | create an issue or episode, optionally with up to 12 `slots` in the same call |
| `POST issues/{rbi}/slots` | add a slot to an issue |
| `GET inventory?from=&to=&publication=` | the calendar: issues in `[from, to]` (default today + 56 days, at most 92 days), each with its slots and each slot's live booking (deal, sponsor, stage, price) or `null` |
| `GET sponsors` · `POST sponsors` · `GET sponsors/{rbn}` · `PATCH sponsors/{rbn}` | the sponsor book; `GET sponsors/{rbn}` includes the sponsor's deals |
| `GET deals?stage=` · `POST deals` | list, create (at `lead`) |
| `GET deals/{rbd}` · `PATCH deals/{rbd}` | detail (bookings with slot, issue and publication; stage history), edit everything but the stage |
| `POST deals/{rbd}/stage` | move through §3 |
| `POST deals/{rbd}/bookings` | book a slot (§2): `201`, or `409 slot_already_booked` |
| `DELETE deals/{rbd}/bookings/{rbb}` | release a booking (§2) |
| `GET pipeline` | per-stage deal count and value per currency, for the board header |

### 4.2 RB2

- `POST deals/{rbd}/insertion-order`, `GET` / `PATCH deals/{rbd}/insertion-order`,
  `POST deals/{rbd}/insertion-order/send` (emails the sponsor contact).
- `PUT deals/{rbd}/bookings/{rbb}/delivery` (create or replace the delivery).
- `POST deals/{rbd}/report-links` (returns the token once),
  `DELETE deals/{rbd}/report-links/{rbr}` (revoke).
- Public, no session: `GET /ingress/rateboard/r/{token}` on api-edge's public
  lane. It is rate-limited per IP by the baseline limiter (family
  `deal-public`) and forwarded to `deal-worker` with no actor headers. The
  console renders it at `/r/[token]`.

### 4.3 RB3: `bench-worker`, behind api-edge's `bench` facade

- `GET benchmark-contribution`, `PUT benchmark-contribution` (opt in),
  `DELETE benchmark-contribution` (revoke). Needs `bench.contribute` (owner,
  admin).
- `GET benchmarks/cells`: the keys of the cells published in the latest
  snapshot, each with its contributor *band*. Needs `bench.read` and a live
  contribution.
- `GET benchmarks?niche=&band=&format=`: one cell. All three keys are required
  and must be exact values. There are no wildcards and no roll-ups (§6.5).
  Needs `bench.read` and a live contribution.

## 5. Events, audit, secrets, integrations

- Audit events (category `deal`), written with the patched,
  D1-portable events path (runbook trap 16): `deal.publication.created|updated`,
  `deal.issue.created`, `deal.slot.created`, `deal.sponsor.created|updated`,
  `deal.created|updated`, `deal.stage.changed`, `deal.booking.created`,
  `deal.booking.released`, and a **refused** double-booking as
  `deal.booking.refused`, so a creator can see that a teammate tried. From
  RB2: `deal.io.*`, `deal.delivery.recorded`, `deal.report_link.created|revoked`.
  From RB3: `bench.contribution.opted_in|revoked`. The aggregate run writes
  no per-org events.
- Payloads carry ids, stages, prices and formats. They never carry sponsor
  contact emails.
- Subject prefixes registered with `events-worker`: `rbp_`, `rbi_`, `rbs_`,
  `rbn_`, `rbd_`, `rbb_`.
- `deal-worker` is on the notifications internal-actor allow-list from RB1,
  so RB2 adds only templates (`deal.io.sent`).
- No new secrets. RB1–RB3 need no third-party credential.

## 6. RB3 — the cross-tenant benchmark, as a security design

### 6.1 What changes, and what does not

Everywhere else in Rateboard, and in the baseline, a tenant's rows are read
only on behalf of a member of that tenant. RB3 adds exactly one exception: a
scheduled job in `bench-worker` reads *contributed* bookings from every
contributing organization and writes *aggregates* that other organizations
can read. Nothing else changes. `deal-worker` gains no cross-org query, no
route returns another org's rows, and the aggregate's output tables hold no
org identifiers that any route serves.

### 6.2 Threat model

| Adversary | Wants | Can |
|---|---|---|
| A curious contributor | a named competitor's rate | read every published cell, query repeatedly, compare snapshots over time, know their own rows exactly |
| A sybil | to isolate one victim in a cell | create several orgs and contribute invented deals to pad a cell |
| A revoker | to leave | expects their rows to stop being used |
| A non-contributor | free benchmarks | call the read routes |
| An insider bug | — | a future route or query that forgets the boundary |

Out of scope: an attacker who controls or knows the true values of all but
one contributor in a cell. No aggregate survives that (the k − 1 collusion
bound). RB-F records it as an accepted residual risk, with the mitigations
that raise its cost.

### 6.3 Consent and what is read

- **Opt-in per organization.** `bench_contributions (org_id PRIMARY KEY,
  opted_in_at, opted_in_by, revoked_at, revoked_by)`. Only an owner or admin
  can opt in or revoke (`bench.contribute`). The console states exactly what
  is shared before the switch is flipped.
- **Revocable.** Revoking sets `revoked_at`. From that moment no aggregate run
  reads the org's rows. At the next weekly run the org is dropped from every
  cell, and the private contributor records (§6.6) that held its id are
  deleted. The published cells it was in are then withheld or recomputed
  without it (§6.6). Re-opting in is a new consent with a new `opted_in_at`.
- **What the job reads.** One SQL statement, in one repository function
  (`packages/db/src/bench`, `readContributedBookings(window)`), which is the
  only function in the codebase that reads `deal_bookings` without an
  `orgId` argument. It selects `org_id`, `format`, `niche`, `audience_size`,
  `price_cents` and `currency` from live bookings whose deal is `booked`,
  `delivered` or `paid` and was booked in the trailing 365 days, **joined to
  `bench_contributions` where `revoked_at IS NULL`**. It never reads sponsor
  names, deal titles, notes, IOs, deliveries or member data. The copies made
  at booking time (§1.6) mean it does not join publications either.
- **Eligible contributors.** An org counts toward a cell only if it opted in
  at least 30 days before the run and has at least 3 qualifying bookings in
  the window. Orgs that share any owner or admin are merged into **one**
  contributor, using the membership context's facts. This raises the cost of
  the sybil attack: one person cannot be five contributors.
- **Currency.** v1 aggregates `USD` bookings only. Other currencies are
  excluded rather than converted at a guessed rate (RB-G).
- **Formats and niches.** `other` is excluded from both.

### 6.4 Cells

A cell is `niche × audience band × format`:

- 15 niches (§1.1, excluding `other`)
- 5 audience bands, fixed: `lt5k` (< 5,000), `5k_15k`, `15k_50k`,
  `50k_150k`, `150k_plus`
- 7 formats (§1.3, excluding `other`)

That is 525 disjoint cells. Every qualifying booking falls into exactly one.
The partition is fixed in code and has no hierarchy. There is no "all
niches" or "all sizes" row.

### 6.5 What is published, and the choice of k

For each cell the job first reduces each contributor to **one value per
metric**: the median of that contributor's bookings in the cell. The metrics
are the flat price per slot, and the effective CPM (`price / audience_size ×
1000`). A contributor with 40 bookings in a cell carries the same weight as
one with 3, so no single org can dominate a cell's distribution.

A cell is **published only if it has at least k = 5 distinct contributors**.
For a published cell the output is exactly:

| Field | Value |
|---|---|
| `niche`, `band`, `format` | the key |
| `flat.p25`, `flat.p50`, `flat.p75` | percentiles of the per-contributor values, by linear interpolation, **rounded to two significant figures** |
| `cpm.p25`, `cpm.p50`, `cpm.p75` | the same for CPM |
| `contributors` | a band, never a count: `5–9`, `10–24`, `25+` |
| `snapshot` | the ISO week of the run |

It never publishes a count, a mean, a minimum, a maximum, a standard
deviation, or any value from a cell below k. An unpublished cell's response
is byte-for-byte the same whether it has 0 or k − 1 contributors
(`{ "published": false }`), so the absence tells a reader nothing about how
close a cell is to the threshold.

**Why k = 5.** Five is the floor used for small-cell suppression in public
statistics, and it is the smallest k at which a single contributor is less
than a quarter of the input to p25/p75. It is combined with four other
controls, so it does not carry the protection alone:

1. one value per contributor, so a dominant org cannot pull the percentiles
   to its own rate;
2. rounding to two significant figures, so even a percentile that coincides
   with one contributor's value (the median of an odd count is one of the
   inputs) is disclosed only to within about 5%, and without attribution;
3. sybil resistance (§6.3);
4. no counts, and no query shape that can be differenced (§6.6).

A larger k would suppress almost every cell in the first year. Rateboard's
market is thousands of creators spread over 525 cells, and a benchmark that
publishes nothing is not a moat. k is a constant in `bench-worker` with a
test pinned to it. Raising it later is safe. Lowering it needs a new entry
in the risks document.

### 6.6 Differencing: two queries, two snapshots

- **Two queries in one snapshot.** The read API accepts only exact cell keys.
  Cells partition the bookings, so any two cells a reader can fetch are
  computed from disjoint sets of bookings, and there is no roll-up to subtract
  a cell from. Subtracting two readable aggregates cannot isolate an org,
  because no two readable aggregates overlap.
- **Two snapshots.** Snapshots are computed weekly, and reads serve only the
  latest completed snapshot, never a live computation. The job keeps, in a
  private table (`bench_cell_contributors (cell_key, snapshot, org_id)`,
  read by no route and pruned to the latest snapshot), the contributor set of
  each cell's last *published* version. A cell is republished only if its new
  contributor set differs from the last published set by **zero orgs, or by
  two or more**. If exactly one org joined or left, the cell is **withheld**
  (published as `false`) until the difference reaches two. Otherwise a reader
  who knew that one competitor had just joined or revoked could read that
  competitor's value off the shift. Withholding never republishes a revoked
  org's data, so revocation still removes the org from every future published
  value.
- **The contributor band** changes only at 10 and 25. It is not a count, so
  it cannot be differenced into one.

### 6.7 Tests RB3 must carry

These run in `tests/bench-worker` over real SQLite (node:sqlite), like every
worker test in this repository.

1. **Threshold.** A cell with 4 eligible contributors is not published, and
   its response equals a cell with 0. With 5 it is published.
2. **No rows.** The published table's columns are exactly the §6.5 fields
   (asserted against the schema), and a published response contains no org
   id, count, minimum, maximum or mean.
3. **Dominance.** One org with 50 bookings at $10,000 and four orgs at about
   $500 publishes p75 ≈ $500, not $10,000.
4. **Query differencing.** Every qualifying booking maps to exactly one cell.
   The read route refuses a query without all three exact keys (422). For
   every pair of published cells in a generated dataset, the sets of bookings
   behind them are disjoint.
5. **Snapshot differencing and revocation.** With 6 contributors published,
   one revokes, and the next run withholds the cell and does not read the
   revoker's rows (the aggregate input excludes the org). When a second org
   changes, the cell republishes. A property test over random join and revoke
   sequences asserts that no two published versions of a cell have
   contributor sets that differ by exactly one org.
6. **Recovery attempt.** A test adversary gets every published output across
   two snapshots in which exactly one target org changed, and tries to solve
   for the target's value. The test asserts that the published outputs carry
   no information that depends on the target alone: they are identical to the
   outputs computed with the target's value replaced by any other.
7. **Consent.** A non-contributing org gets `404` on the read routes, and
   neither `benchmark-contribution` route accepts a builder or viewer.
8. **Boundary.** A static test asserts that `readContributedBookings` is the
   only exported repository function over `deal_*` tables without an `orgId`
   parameter, and that `deal-worker` does not import it.

### 6.8 Operations

The cron runs Mondays at 04:00 UTC. A run records `bench_runs (id, snapshot,
started_at, finished_at, contributors, cells_published, cells_withheld)`.
These totals are operator-visible only, never served by a product route. A
run that fails leaves the previous snapshot in place.

## 7. The console

- **Pipeline** (`/orgs/[org]/pipeline`): one column per stage with its count
  and value, deal cards showing sponsor, title and value, a "New deal" form
  (existing sponsor or a new sponsor by name), and move buttons for the
  allowed transitions only.
- **Deal** (`/orgs/[org]/deals/[dealId]`): the deal's fields, its live and
  released bookings, a "Book a slot" picker listing open slots in the next 90
  days, release buttons, stage moves, and the stage history. A refused
  double-booking shows the server's 409 message.
- **Inventory** (`/orgs/[org]/inventory`): the calendar, issues grouped by
  date with each slot marked open or booked (sponsor and deal), and forms to
  add a publication, an issue with slots, or a slot.
- **Sponsors** (`/orgs/[org]/sponsors`): the sponsor book.
- From RB2: IO, delivery and report-link panels on the deal page, and the
  public `/r/[token]` report. From RB3: Settings → Benchmarks (the consent
  switch, with the exact field list) and a Benchmarks page.

The Solo profile is off. `SOLO_MODE=false` on api-edge, identity-worker and
membership-worker, and `NEXT_PUBLIC_SOLO_MODE=false` in the console, because an
agency's staff share an org and an agency may run several.

## 8. Out of scope

- Live audience stats from the Beehiiv, Substack, ConvertKit or Spotify APIs,
  and the media kit built from them (RB-B: no credentials).
- Invoicing and payment collection through a payment provider (RB-C). RB2's IO
  records a payment-due date. `paid` is set by hand.
- Plan limits (Free: 3 active deals) and Polar plans (RB-D).
- Public media-kit pages on subdomains. A hand-entered media kit is a
  candidate for a later milestone.
- Click tracking of sponsor links. RB2's stats are what the creator reports.
- The `rateboard.app` domain and production email sending (runbook trap 27).
