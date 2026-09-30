-- 210_deal_paperwork
-- The paperwork that follows a booking (RB2): one insertion order per deal,
-- numbered per org; one delivery per booking with the stats the creator
-- reports; and revocable, no-login sponsor report links stored only as hashes.
-- Bounded context: deal
-- Seeds nothing; any later seed must be `ON CONFLICT DO NOTHING` (migrations replay).

CREATE TABLE IF NOT EXISTS deal_insertion_orders (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  deal_id          TEXT NOT NULL REFERENCES deal_deals (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  terms            TEXT NOT NULL DEFAULT '',
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  payment_due_on   TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','signed')),
  send_count       INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  sent_at          TEXT,
  sent_to          TEXT,
  notification_id  TEXT,
  signed_at        TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'signed' OR signed_at IS NOT NULL)
);

-- table deal_insertion_orders: One insertion order per deal, numbered per org (IO-0001). Every query must scope by org_id.
-- column deal_insertion_orders.seq: The per-org IO number, claimed with INSERT … SELECT COALESCE(MAX(seq), 0) + 1 under uq_deal_ios_org_seq.
-- column deal_insertion_orders.total_cents: The IO total in integer minor units of currency. Never a float.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_ios_deal ON deal_insertion_orders (deal_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_ios_org_seq ON deal_insertion_orders (org_id, seq);

CREATE TABLE IF NOT EXISTS deal_deliveries (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  deal_id       TEXT NOT NULL REFERENCES deal_deals (id) ON DELETE CASCADE,
  booking_id    TEXT NOT NULL REFERENCES deal_bookings (id) ON DELETE CASCADE,
  delivered_on  TEXT NOT NULL,
  proof_url     TEXT,
  opens         INTEGER CHECK (opens IS NULL OR opens >= 0),
  clicks        INTEGER CHECK (clicks IS NULL OR clicks >= 0),
  impressions   INTEGER CHECK (impressions IS NULL OR impressions >= 0),
  downloads     INTEGER CHECK (downloads IS NULL OR downloads >= 0),
  notes         TEXT NOT NULL DEFAULT '',
  recorded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table deal_deliveries: Proof that one booking ran, with the stats the creator reports. Every query must scope by org_id.
-- column deal_deliveries.opens: Hand-entered; there is no stats integration (RB-B).

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_deliveries_booking ON deal_deliveries (booking_id);
CREATE INDEX IF NOT EXISTS idx_deal_deliveries_deal ON deal_deliveries (deal_id);

CREATE TABLE IF NOT EXISTS deal_report_links (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  deal_id         TEXT NOT NULL REFERENCES deal_deals (id) ON DELETE CASCADE,
  token_sha256    TEXT NOT NULL CHECK (length(token_sha256) = 64),
  expires_at      TEXT,
  last_viewed_at  TEXT,
  view_count      INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at      TEXT,
  revoked_by      TEXT
);

-- table deal_report_links: A no-login link to one deal's delivery report. Only the SHA-256 of the token is stored. Every query must scope by org_id, except the public lookup by token_sha256.
-- column deal_report_links.token_sha256: Hex SHA-256 of the 32-byte random token; the token itself is shown once and never stored.

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_report_links_token ON deal_report_links (token_sha256);
-- At most one live (unrevoked) link per deal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_report_links_live ON deal_report_links (deal_id) WHERE revoked_at IS NULL;
