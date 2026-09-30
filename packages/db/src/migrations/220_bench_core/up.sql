-- 220_bench_core
-- Opt-in rate benchmarks (RB3): per-org consent, the weekly runs, the
-- published cells and the private record of who was behind each published
-- version of a cell.
-- Bounded context: bench
-- schema bench: The ONE cross-tenant surface in Rateboard (epic design §6).
-- Only the bench context reads across orgs, only through
-- readContributedBookings, and only for orgs with a live contribution.
-- Seeds nothing; any later seed must be `ON CONFLICT DO NOTHING` (migrations replay).

CREATE TABLE IF NOT EXISTS bench_contributions (
  org_id       TEXT PRIMARY KEY,
  opted_in_at  TEXT NOT NULL,
  opted_in_by  TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT
);

-- table bench_contributions: One row per org that ever opted in. Live while revoked_at IS NULL; re-opting in is a new consent with a new opted_in_at.

CREATE TABLE IF NOT EXISTS bench_runs (
  id               TEXT PRIMARY KEY,
  snapshot         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  contributors     INTEGER,
  cells_published  INTEGER,
  cells_withheld   INTEGER
);

-- table bench_runs: One row per aggregate run. Operator-visible only; no product route serves these totals.

CREATE UNIQUE INDEX IF NOT EXISTS uq_bench_runs_snapshot ON bench_runs (snapshot);
CREATE INDEX IF NOT EXISTS idx_bench_runs_done ON bench_runs (status, finished_at);

-- The published output: EXACTLY the design §6.5 fields, and nothing that
-- identifies an org, counts contributors or carries a minimum, maximum or
-- mean. Money is USD cents, each percentile rounded to two significant figures.
CREATE TABLE IF NOT EXISTS bench_cells (
  snapshot      TEXT NOT NULL,
  niche         TEXT NOT NULL,
  band          TEXT NOT NULL CHECK (band IN ('lt5k','5k_15k','15k_50k','50k_150k','150k_plus')),
  format        TEXT NOT NULL,
  flat_p25      INTEGER NOT NULL,
  flat_p50      INTEGER NOT NULL,
  flat_p75      INTEGER NOT NULL,
  cpm_p25       INTEGER NOT NULL,
  cpm_p50       INTEGER NOT NULL,
  cpm_p75       INTEGER NOT NULL,
  contributors  TEXT NOT NULL CHECK (contributors IN ('5–9','10–24','25+')),
  PRIMARY KEY (snapshot, niche, band, format)
);

-- table bench_cells: Published benchmark cells per snapshot. Reads serve only the latest completed snapshot; older snapshots are pruned after a run completes.

-- PRIVATE: read by no route. For each cell, the members behind every version
-- that was published, so a new version whose member set differs from ANY
-- published one by exactly one org is withheld (design §6.6). Members are a
-- one-way pseudonym of the org id (SHA-256), never the id itself.
CREATE TABLE IF NOT EXISTS bench_cell_contributors (
  cell_key  TEXT NOT NULL,
  snapshot  TEXT NOT NULL,
  member    TEXT NOT NULL CHECK (length(member) = 64),
  PRIMARY KEY (cell_key, snapshot, member)
);

-- table bench_cell_contributors: Private membership of each published cell version, as pseudonyms. Never served.
