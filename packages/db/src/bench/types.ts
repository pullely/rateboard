// Bench (bench) bounded context — RB3, opt-in rate benchmarks.
//
// The ONE cross-tenant read in Rateboard lives here: `readContributedBookings`
// is the only repository function over deal_* tables without an orgId
// argument (a static test pins this). Everything else in this repository is
// org-scoped (consent) or touches only bench_* tables (the snapshot).

export interface Contribution {
  orgId: string;
  optedInAt: string;
  optedInBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/**
 * One contributed booking, as the aggregate reads it: the org (for grouping
 * and eligibility only — it never leaves the job), the copies made at booking
 * time, the price and the org's opt-in time. No sponsor, title, note, IO,
 * delivery or member data.
 */
export interface ContributedBooking {
  orgId: string;
  format: string;
  niche: string;
  audienceSize: number;
  priceCents: number;
  currency: string;
  optedInAt: string;
}

/** An owner or admin of an org, for merging orgs that share one (sybil resistance). */
export interface OrgAdmin {
  orgId: string;
  subjectId: string;
}

export interface BenchCellRow {
  snapshot: string;
  niche: string;
  band: string;
  format: string;
  flatP25: number;
  flatP50: number;
  flatP75: number;
  cpmP25: number;
  cpmP50: number;
  cpmP75: number;
  contributors: string;
}

export interface BenchRun {
  id: string;
  snapshot: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  contributors: number | null;
  cellsPublished: number | null;
  cellsWithheld: number | null;
}

export interface BenchRepository {
  // ── consent (org-scoped) ──
  getContribution(orgId: string): Promise<Contribution | null>;
  /** Opt in, or re-opt in after a revocation (a new consent, a new opted_in_at). null = already contributing. */
  optIn(orgId: string, by: string | null, now: string): Promise<Contribution | null>;
  /** null = not contributing. */
  revoke(orgId: string, by: string | null, now: string): Promise<Contribution | null>;

  // ── the aggregate (bench-worker's scheduled job only) ──
  /**
   * THE cross-tenant read (design §6.3): live bookings of booked, delivered or
   * paid deals booked since `since`, in USD, with a real niche, format and
   * audience, of orgs whose contribution is live — joined to
   * bench_contributions WHERE revoked_at IS NULL, in the same statement.
   */
  readContributedBookings(window: { since: string }): Promise<ContributedBooking[]>;
  /** Owners and admins of the given orgs (membership facts), for merging orgs that share one. */
  readOrgAdmins(orgIds: readonly string[]): Promise<OrgAdmin[]>;

  /** Claim this run's snapshot label: `<ISO week>`, or `<ISO week>.<n>` for the n-th run in the same week. */
  startRun(input: { id: string; week: string; now: string }): Promise<BenchRun | null>;
  finishRun(input: { id: string; now: string; contributors: number; cellsPublished: number; cellsWithheld: number }): Promise<void>;
  failRun(id: string, now: string): Promise<void>;
  latestSnapshot(): Promise<string | null>;
  listRuns(limit: number): Promise<BenchRun[]>;

  /** Every published member set of every cell: cell_key → snapshot → members. */
  readPublishedMembers(): Promise<Map<string, Map<string, Set<string>>>>;
  writeCells(rows: readonly BenchCellRow[]): Promise<void>;
  writeMembers(rows: readonly { cellKey: string; snapshot: string; member: string }[]): Promise<void>;
  /** Drop published cells of every snapshot but `keep`. */
  pruneCells(keep: string): Promise<void>;

  // ── reads (contributing orgs only; the worker checks) ──
  readCell(snapshot: string, niche: string, band: string, format: string): Promise<BenchCellRow | null>;
  listCells(snapshot: string): Promise<BenchCellRow[]>;
}
