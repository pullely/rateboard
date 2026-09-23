# Epic: rateboard-sponsor-pipeline (RB)

**Independent newsletter writers and podcasters sell sponsorships out of Gmail
labels and spreadsheets. They lose track of which issue or episode a sponsor
was promised, sometimes sell the same slot twice, and set their prices by
guessing, because nobody publishes what creators of their size in their niche
actually charge. This epic builds Rateboard in three steps. First, a sponsor
pipeline (lead → pitched → booked → delivered → paid) over an inventory
calendar of ad slots per issue or episode, where the database refuses a second
booking of a slot rather than the UI warning about one. Second, the paperwork
that follows a booking: the insertion order, proof of delivery with the
numbers the creator reports, and a no-login report link for the sponsor.
Third, the moat: opt-in rate benchmarks. Anonymised price percentiles by niche,
audience size and ad format, computed only from the deals of creators who
chose to contribute, and published only for cells with at least five
independent contributors. The one design idea: every deal is recorded against
a structured slot (publication niche, audience size at booking, ad format,
price), so the pipeline a creator needs anyway produces, with their consent,
the dataset nobody else has. The tenant boundary moves in exactly one place,
and design §6 treats that place as a security design.**

Rateboard is for independent newsletters (Beehiiv, Substack, ConvertKit) and
podcasts with 2k–200k audience, and for small creator-management agencies that
run several of them. A creator adds their publications, lays out the ad slots
in each upcoming issue or episode, logs sponsors and deals, and books deals
into slots. The calendar shows at a glance what is sold, and a double-booking
is impossible. From RB2 the creator issues an insertion order per booked deal,
records delivery with the stats they have, and sends the sponsor a report
link. From RB3 a creator who opts in to contribute sees what comparable
creators charge.

## Status

| Field | Value |
|-------|-------|
| Status | In progress (RB0 ✅, RB1 in review) |
| Cluster | **RB** (RB0–RB3) |
| Owner(s) | `apps/deal-worker` (publications, issues, slots, sponsors, deals, bookings; from RB2 insertion orders, deliveries and report links) · `apps/bench-worker` (RB3: contributions, the weekly aggregate, the published benchmark cells) · `apps/api-edge` (the facades and, from RB2, the public report lane) · `packages/db` (migrations `200`–`220`) · `packages/contracts` + `packages/sdk` (the wire) · `apps/notifications-worker` (RB2 templates) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12`: organizations as a creator's business or an agency, members and the policy engine for who may sell, the audit trail in `events-worker`, `notifications-worker` for email, api-edge rate limiting and its public ingress lane, cron triggers |
| Changes | Adds two bounded contexts (`deal`, `bench`), two workers, one cron trigger (RB3) and one public lane (RB2). Turns the Solo profile off, because an agency's staff share an organization and an agency runs several. Baseline contexts are reused and only gain actions, templates and subject prefixes. |
| Decisions locked | (1) A slot can hold at most one live booking, enforced by a partial unique index in D1 and claimed with a single `INSERT … ON CONFLICT DO NOTHING RETURNING` statement. The console's "already booked" message comes from that refusal. There is no read-then-write check. (2) Deal stages move through a fixed state machine, each move a conditional `UPDATE … WHERE stage = <expected> RETURNING`, so two people moving the same deal at once cannot both succeed. (3) Money is integer minor units plus an ISO currency code, never a float. A booking copies the slot's format and the publication's audience size at booking time, so later edits do not rewrite history or the benchmarks. (4) The benchmark crosses tenants only through the `bench` context. Contribution is opt-in per organization and revocable. The aggregate reads contributed bookings only. A cell is published only with at least **k = 5** independent contributors, one value per contributor, as rounded p25/p50/p75. Counts below k, rows, means, minima and maxima are never published (design §6). (5) Audience stats are entered by hand. Pulling them from Beehiiv, Substack, ConvertKit or Spotify needs credentials nobody has handed us and is a later milestone (RB-B). |
| Gate | RB1 is the first user-visible change: the pipeline and the calendar. RB2 adds the paperwork around a booked deal. RB3 opens the one cross-tenant surface, behind the controls of design §6. |
| Shipped as | |

## Read order

1. `design.md`: the resources, the booking guarantee, the pipeline state machine, the routes, the surfaces, the benchmark security design (§6), and what is out of scope
2. `implementation-plan.md`: the milestones and what "done" means for each
3. `risks-and-open-questions.md`: what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md`: what actually shipped, kept separate from intent

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| RB0 — the spec | this doc set | merged and pushed with `orun spec push` |
| RB1 — the deal pipeline and the inventory calendar | the `deal` context (migration `200_deal_core`), `deal-worker`: publications (with niche and audience size), issues or episodes, ad slots, sponsors, deals through lead → pitched → booked → delivered → paid (and lost), bookings of deals into slots with a D1-enforced one-live-booking-per-slot constraint, the inventory calendar, audit events, and the console Pipeline, Deal, Inventory and Sponsors pages | on stage a signed-in user creates an org (201), a publication, an issue with slots and a sponsor, moves a deal lead → pitched → booked → delivered → paid, books a slot, a second booking of that slot is refused with 409, and a non-member gets 404 |
| RB2 — insertion orders, proof of delivery and the sponsor report link | `210_deal_paperwork`: one insertion order per booked deal (numbered per org, emailed to the sponsor contact), delivery recorded per booking with hand-entered stats (opens, clicks, downloads, impressions) and a proof URL, the rule that a deal reaches `delivered` only when every booking has a delivery, and a public, single-purpose, revocable sponsor report link served with no login | on stage an IO is issued and emailed, both bookings get deliveries, the deal moves to delivered, the report link serves the delivered slots and stats with no session, and after revocation the same link answers 404 |
| RB3 — opt-in rate benchmarks | `220_bench_core`, `bench-worker`: per-org opt-in and revocation (owner or admin only), a weekly cron that aggregates contributed bookings into niche × audience band × format cells under the controls of design §6, and the benchmark read for contributing orgs | the tests of design §6.7 pass, including the differencing tests; on stage six seeded contributors publish a cell, a single revocation withholds it at the next run, and a non-contributing org gets no benchmark data |

Later, and not built here: the media kit from live audience stats (Beehiiv,
Substack, ConvertKit and Spotify APIs, RB-B), invoicing and payment collection
through a payment provider (RB-C), plan limits (Free: 3 active deals) through
Polar (RB-D), public media-kit pages on subdomains, and the `rateboard.app`
domain. See `risks-and-open-questions.md`.
