# rateboard-sponsor-pipeline — risks and open questions

Each entry has a letter, a title and a state:

- **RISK**: open, with a mitigation.
- **RESOLVED**: decided. The entry says what was decided and why.
- **ACCEPTED**: a cost we carry knowingly.
- **SETTLED**: decided for now, to be revisited on a stated cadence.

## RB-A — Double-booking under concurrency (RESOLVED)

A read-then-insert check lets two concurrent requests book one slot. Decided:
a partial unique index on live bookings, claimed in one `INSERT … SELECT …
ON CONFLICT DO NOTHING RETURNING` statement (design §2), with the outcome read
from the returned rows. D1 has no interactive transactions, so no other shape
is both atomic and portable. A test fires many concurrent claims at one slot
and expects exactly one 201.

## RB-B — Live audience stats and the auto-generated media kit (RISK, open)

The pitch's media kit is built from Beehiiv, Substack, ConvertKit and Spotify
statistics. None of those credentials, OAuth apps or partner agreements were
handed to this build, and Substack has no public stats API. Audience size is
entered by hand in RB1. Delivery stats are entered by hand in RB2. A
hand-entered media kit can come later. The API-fed one needs, per platform, an
OAuth app registered by the owner, an integrations-worker provider, and a
decision on how often stats refresh. Hand-entered sizes also feed RB3, so a
creator who overstates their audience lowers the CPM they appear to charge.
That is mitigated by RB3 aggregating per-contributor medians (RB-F), and
removed once sizes come from the platforms.

## RB-C — Invoicing and payment collection (RISK, open)

The pitch lists invoicing. Collecting money needs a payment provider credential
(Stripe or Polar invoicing) nobody has handed us. RB2 records a payment-due
date on the IO. `paid` is a manual stage.

## RB-D — Plan limits: Free, 3 active deals (RISK, open)

The business model caps Free at 3 active deals. The baseline's Polar billing
and entitlements can express it, but the Polar products and prices are the
owner's decision and cost nothing to defer. Until then every org is unlimited.
When it lands, the cap is checked in the same conditional insert as the deal
(count of deals not `paid` or `lost`), not read-then-write.

## RB-E — The benchmark crosses tenants (SETTLED, review at RB3 and every change to §6)

This is the one place Rateboard reads across organizations. It is governed by
design §6: opt-in and revocable consent, a single repository function as the
only cross-org read, k = 5 distinct contributors, one value per contributor,
two-significant-figure rounding, contributor bands instead of counts, a fixed
disjoint partition with no roll-ups, weekly snapshots, and change-by-one
withholding. Any new benchmark query shape (a roll-up, a filter, a trend over
time, an export) reopens this entry and needs a differencing argument and a
test before it ships.

## RB-F — k − 1 collusion and sybils (ACCEPTED)

If an attacker controls or knows the true values of every other contributor
in a cell, the published percentiles narrow the remaining contributor's value
to the rounding interval. No aggregate prevents this. We raise its cost:
contributors that share an owner or admin count as one, an org must have opted
in 30 days before a run and have at least 3 qualifying bookings, and values are
rounded to two significant figures. Invented deals are possible. A future
milestone could weight contributors by verified delivery (RB2 proof URLs) or by
platform-verified audience (RB-B).

## RB-G — Currency in the benchmark (SETTLED, v1)

The benchmark aggregates USD bookings only. Converting other currencies needs
a rate source and a date convention. Mixing currencies without converting
would be wrong. Non-USD bookings are recorded normally and left out of the
benchmark. Revisit when a non-USD cell would reach k.

## RB-H — Audience bands and niches are coarse (SETTLED)

Five bands and fifteen niches give 525 cells. Finer cells would identify
creators (a "25k–30k climbing newsletter" is one person) and would rarely
reach k. Changing the lists changes the cell keys, so it needs a migration
that re-keys the published snapshot, and a review under RB-E.

## RB-I — Audit trail and dual writes (ACCEPTED)

D1 has no interactive transactions. A stage move followed by the release of a
lost deal's bookings, or a write followed by its audit event, is two
statements. The state-changing statement runs first and is authoritative. A
failed follow-up is logged and does not undo it. A lost deal whose bookings
failed to release shows them in the calendar until they are released by hand.
That is visible, not silent.

## RB-J — The baseline's Postgres-only SQL on D1 (RESOLVED in RB1)

The cirrus baseline ships `appendEventWithAudit` and the membership org-create
and invitation-accept statements as Postgres-only SQL that D1 cannot run, so no
organization can be created on a fresh deployment (runbook trap 16). RB1
applies the portfolio's tested patch, and touches every worker's
`component.yaml` so the shared-package fix is redeployed everywhere (trap 17).

## RB-K — Production sign-in (RISK, open; owner's decision)

Magic-link email in production needs a verified sending domain, and
`rateboard.app` is not held (runbook trap 27). Stage sign-in works through
`DEBUG_DELIVERY`, which stays off in production. Real production use needs the
domain and a sending setup, which cost money.
