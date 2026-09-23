-- 200_deal_core
-- Sponsor pipeline foundation (RB1) — publications, their issues or episodes,
-- the ad slots in each, sponsors, deals moving through the pipeline, the
-- bookings of deals into slots, and each deal's stage history
-- Bounded context: deal
-- schema deal: Deal bounded context — owns a creator's sellable inventory
-- (publication → issue → slot), the sponsor book, the deals and their stage
-- machine, and the bookings. A slot holds at most ONE live booking: that is
-- enforced here, by uq_deal_bookings_live_slot, not by the UI. Seeds nothing;
-- any later seed must be `ON CONFLICT DO NOTHING` (migrations replay).

CREATE TABLE IF NOT EXISTS deal_publications (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL COLLATE NOCASE,
  kind           TEXT NOT NULL CHECK (kind IN ('newsletter','podcast')),
  niche          TEXT NOT NULL CHECK (niche IN ('tech','business','finance','marketing','health','food','travel',
                   'parenting','education','news_politics','science','gaming','lifestyle','crypto','careers','other')),
  audience_size  INTEGER NOT NULL CHECK (audience_size >= 0 AND audience_size <= 100000000),
  platform       TEXT CHECK (platform IS NULL OR platform IN ('beehiiv','substack','convertkit','ghost','spotify','apple','other')),
  currency       TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table deal_publications: A newsletter or podcast the org sells sponsorships in. Every query must scope by org_id.
-- column deal_publications.niche: A fixed list, never free text: RB3's benchmark cells are keyed by it.
-- column deal_publications.audience_size: Subscribers (newsletter) or average downloads per episode (podcast), entered by hand.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_publications_org_name ON deal_publications (org_id, name);

CREATE TABLE IF NOT EXISTS deal_issues (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  publication_id  TEXT NOT NULL REFERENCES deal_publications (id) ON DELETE CASCADE,
  title           TEXT NOT NULL COLLATE NOCASE,
  publish_on      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','published','cancelled')),
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table deal_issues: One dated newsletter issue or podcast episode. Every query must scope by org_id.
-- column deal_issues.publish_on: YYYY-MM-DD; the inventory calendar orders and filters by it.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_issues_publication_title ON deal_issues (publication_id, title);
CREATE INDEX IF NOT EXISTS idx_deal_issues_org_date ON deal_issues (org_id, publish_on);

CREATE TABLE IF NOT EXISTS deal_slots (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  issue_id          TEXT NOT NULL REFERENCES deal_issues (id) ON DELETE CASCADE,
  publication_id    TEXT NOT NULL REFERENCES deal_publications (id) ON DELETE CASCADE,
  label             TEXT NOT NULL COLLATE NOCASE,
  format            TEXT NOT NULL CHECK (format IN ('nl_primary','nl_secondary','nl_classified','nl_dedicated',
                      'pod_preroll','pod_midroll','pod_postroll','other')),
  list_price_cents  INTEGER CHECK (list_price_cents IS NULL OR list_price_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table deal_slots: A sellable ad position in one issue or episode. Every query must scope by org_id.
-- column deal_slots.list_price_cents: The asking price in integer minor units of currency. Never a float.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_slots_issue_label ON deal_slots (issue_id, label);

CREATE TABLE IF NOT EXISTS deal_sponsors (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL COLLATE NOCASE,
  website        TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table deal_sponsors: A company that buys sponsorships from the org. Every query must scope by org_id.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_sponsors_org_name ON deal_sponsors (org_id, name);

CREATE TABLE IF NOT EXISTS deal_deals (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  sponsor_id        TEXT NOT NULL REFERENCES deal_sponsors (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  stage             TEXT NOT NULL DEFAULT 'lead'
                    CHECK (stage IN ('lead','pitched','booked','delivered','paid','lost')),
  value_cents       INTEGER CHECK (value_cents IS NULL OR value_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  pricing           TEXT NOT NULL DEFAULT 'flat' CHECK (pricing IN ('flat','cpm')),
  cpm_cents         INTEGER CHECK (cpm_cents IS NULL OR cpm_cents >= 0),
  notes             TEXT NOT NULL DEFAULT '',
  stage_changed_at  TEXT NOT NULL,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (pricing <> 'cpm' OR cpm_cents IS NOT NULL)
);

-- table deal_deals: One sale to one sponsor. Every query must scope by org_id.
-- column deal_deals.stage: lead → pitched → booked → delivered → paid, or lost; changed only by a conditional UPDATE … WHERE stage = <expected> RETURNING.
-- column deal_deals.value_cents: The agreed total in integer minor units of currency. Never a float.

CREATE INDEX IF NOT EXISTS idx_deal_deals_org_stage ON deal_deals (org_id, stage, stage_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_deals_sponsor ON deal_deals (sponsor_id);

CREATE TABLE IF NOT EXISTS deal_bookings (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  deal_id         TEXT NOT NULL REFERENCES deal_deals (id) ON DELETE CASCADE,
  slot_id         TEXT NOT NULL REFERENCES deal_slots (id) ON DELETE CASCADE,
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  currency        TEXT NOT NULL CHECK (length(currency) = 3),
  format          TEXT NOT NULL,
  niche           TEXT NOT NULL,
  audience_size   INTEGER NOT NULL CHECK (audience_size >= 0),
  booked_by       TEXT,
  booked_at       TEXT NOT NULL,
  released_at     TEXT,
  released_by     TEXT,
  release_reason  TEXT CHECK (release_reason IS NULL OR release_reason IN ('released','deal_lost')),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

-- table deal_bookings: A deal's claim on one slot. Live while released_at IS NULL; released rows are kept as history. Every query must scope by org_id.
-- column deal_bookings.format: Copied from the slot at booking time; RB3 aggregates the copy, so later edits never rewrite history.
-- column deal_bookings.niche: Copied from the publication at booking time.
-- column deal_bookings.audience_size: Copied from the publication at booking time; the effective CPM is price / audience_size × 1000.

-- THE double-booking guarantee: at most one live booking per slot, whatever
-- the application does. Claims are INSERT … ON CONFLICT DO NOTHING RETURNING.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_bookings_live_slot ON deal_bookings (slot_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deal_bookings_deal ON deal_bookings (deal_id, released_at);
CREATE INDEX IF NOT EXISTS idx_deal_bookings_org ON deal_bookings (org_id, booked_at);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  deal_id     TEXT NOT NULL REFERENCES deal_deals (id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  changed_by  TEXT,
  changed_at  TEXT NOT NULL
);

-- table deal_stage_history: Every stage a deal has entered, creation included (from_stage NULL). Every query must scope by org_id.

CREATE INDEX IF NOT EXISTS idx_deal_stage_history_deal ON deal_stage_history (deal_id, changed_at);
