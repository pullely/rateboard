import {
  BENCH_K,
  BENCH_MIN_BOOKINGS,
  audienceBand,
  contributorBand,
  type BenchBand,
  type ContributorBand,
} from "@saas/contracts/bench";
import type { BenchCellRow, ContributedBooking, OrgAdmin } from "@saas/db/bench";

/**
 * The benchmark aggregate (epic design §6), as a pure function of what the
 * run read. No I/O here: the scheduled job reads, calls `computeSnapshot`,
 * and writes what it returns. The tests drive this directly and through the
 * job over real SQLite.
 */

export const K = BENCH_K;

/** `niche|band|format` — the exact key of one of the 525 disjoint cells. */
export function cellKeyOf(b: Pick<ContributedBooking, "niche" | "format" | "audienceSize">): string {
  return `${b.niche}|${audienceBand(b.audienceSize)}|${b.format}`;
}

/** Round to two significant figures (an integer in, an integer out). */
export function round2sf(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const step = Math.pow(10, magnitude - 1);
  return Math.round(Math.round(value / step) * step);
}

/** Percentile by linear interpolation between closest ranks (the "type 7" definition). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

export function median(values: readonly number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** The effective CPM of one booking, in cents per thousand audience. */
export function cpmOf(b: Pick<ContributedBooking, "priceCents" | "audienceSize">): number {
  return (b.priceCents / b.audienceSize) * 1000;
}

/** A one-way pseudonym of an org id; the private member record never holds the id. */
export async function memberOf(orgId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rateboard-bench-member:${orgId}`));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** `usr_<32 hex>` and a UUID name the same subject (runbook trap 39): compare in one form. */
export function normalizeSubject(subjectId: string): string {
  const m = /^usr_([0-9a-f]{32})$/i.exec(subjectId);
  if (m) {
    const h = m[1]!.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return subjectId.toLowerCase();
}

export interface SnapshotInput {
  bookings: readonly ContributedBooking[];
  admins: readonly OrgAdmin[];
  /** The run's time, ISO-8601. */
  now: string;
  /** Minimum days between opt-in and the run (30; stage may lower it, prod never). */
  minOptinDays: number;
  /** cell key → snapshot → the pseudonymous members of each PUBLISHED version. */
  published: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /** org id → pseudonym (precomputed by the caller; `memberOf`). */
  members: ReadonlyMap<string, string>;
  snapshot: string;
}

export interface SnapshotOutput {
  cells: BenchCellRow[];
  /** The member set of each newly published cell version, to record. */
  memberRows: { cellKey: string; snapshot: string; member: string }[];
  /** Cells with at least one contributor that were not published (below k, or withheld by the change-by-one rule). */
  withheld: string[];
  /** Why each withheld cell was withheld — for tests and the operator log, never served. */
  reasons: Map<string, "below_k" | "change_by_one">;
  /** Independent contributors across all cells, after merging. */
  contributors: number;
  /** The orgs whose rows fed this snapshot (for tests: a revoked org is never among them). */
  inputOrgs: Set<string>;
}

/** Group eligible orgs that share any owner or admin into one contributor (union–find). */
export function mergeByAdmins(orgIds: readonly string[], admins: readonly OrgAdmin[]): Map<string, string> {
  const parent = new Map<string, string>(orgIds.map((o) => [o, o]));
  const find = (o: string): string => {
    let r = o;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(o, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const bySubject = new Map<string, string>();
  for (const a of admins) {
    if (!parent.has(a.orgId)) continue;
    const s = normalizeSubject(a.subjectId);
    const seen = bySubject.get(s);
    if (seen) union(seen, a.orgId);
    else bySubject.set(s, a.orgId);
  }
  return new Map(orgIds.map((o) => [o, find(o)]));
}

/** Size of the symmetric difference of two sets. */
export function diffSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}

export function computeSnapshot(input: SnapshotInput): SnapshotOutput {
  const cutoff = Date.parse(input.now) - input.minOptinDays * 86_400_000;

  // 1. Eligibility per org: opted in long enough, and ≥ 3 qualifying bookings.
  const perOrg = new Map<string, ContributedBooking[]>();
  for (const b of input.bookings) {
    if (b.currency !== "USD" || b.audienceSize <= 0 || b.niche === "other" || b.format === "other") continue;
    (perOrg.get(b.orgId) ?? perOrg.set(b.orgId, []).get(b.orgId)!).push(b);
  }
  const eligible = [...perOrg.entries()]
    .filter(([, rows]) => rows.length >= BENCH_MIN_BOOKINGS && Date.parse(rows[0]!.optedInAt) <= cutoff)
    .map(([org]) => org)
    .sort();

  // 2. Sybil resistance: orgs sharing an owner or admin are ONE contributor.
  const contributorOf = mergeByAdmins(eligible, input.admins);
  const contributors = new Set(contributorOf.values()).size;

  // 3. Per cell, per contributor: the median of that contributor's bookings.
  const cells = new Map<string, Map<string, ContributedBooking[]>>();
  const inputOrgs = new Set<string>();
  for (const org of eligible) {
    inputOrgs.add(org);
    const c = contributorOf.get(org)!;
    for (const b of perOrg.get(org)!) {
      const key = cellKeyOf(b);
      const byContributor = cells.get(key) ?? cells.set(key, new Map()).get(key)!;
      (byContributor.get(c) ?? byContributor.set(c, []).get(c)!).push(b);
    }
  }

  const out: SnapshotOutput = { cells: [], memberRows: [], withheld: [], reasons: new Map(), contributors, inputOrgs };
  for (const key of [...cells.keys()].sort()) {
    const byContributor = cells.get(key)!;
    const n = byContributor.size;
    const band: ContributorBand | null = contributorBand(n);
    if (n < K || band === null) {
      out.withheld.push(key);
      out.reasons.set(key, "below_k");
      continue;
    }
    // 4. Differencing across snapshots: never publish a version whose member
    //    set differs from ANY published version of this cell by exactly one org.
    const orgsInCell = new Set<string>();
    for (const rows of byContributor.values()) for (const b of rows) orgsInCell.add(input.members.get(b.orgId)!);
    const history = input.published.get(key);
    if (history && [...history.values()].some((prev) => diffSize(prev, orgsInCell) === 1)) {
      out.withheld.push(key);
      out.reasons.set(key, "change_by_one");
      continue;
    }
    const flats = [...byContributor.values()].map((rows) => median(rows.map((b) => b.priceCents))).sort((a, b) => a - b);
    const cpms = [...byContributor.values()].map((rows) => median(rows.map(cpmOf))).sort((a, b) => a - b);
    const [niche, cellBand, format] = key.split("|") as [string, BenchBand, string];
    out.cells.push({
      snapshot: input.snapshot,
      niche,
      band: cellBand,
      format,
      flatP25: round2sf(percentile(flats, 0.25)),
      flatP50: round2sf(percentile(flats, 0.5)),
      flatP75: round2sf(percentile(flats, 0.75)),
      cpmP25: round2sf(percentile(cpms, 0.25)),
      cpmP50: round2sf(percentile(cpms, 0.5)),
      cpmP75: round2sf(percentile(cpms, 0.75)),
      contributors: band,
    });
    for (const member of [...orgsInCell].sort()) out.memberRows.push({ cellKey: key, snapshot: input.snapshot, member });
  }
  return out;
}

/** ISO-8601 week of a date, e.g. `2026-W40`. */
export function isoWeek(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
