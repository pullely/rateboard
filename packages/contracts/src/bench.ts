/**
 * Bench (`bench`) bounded context — Rateboard's opt-in rate benchmarks (RB3).
 * The one place Rateboard reads across tenants, built as a security design
 * (epic design §6): opt-in per org and revocable, one value per contributor,
 * k = 5 independent contributors per published cell, 525 disjoint exact-key
 * cells, rounded percentiles and a contributor band — never a count or a row.
 */
import type { Niche, SlotFormat } from "./deal.js";

/** The minimum number of independent contributors for a cell to publish. Raising it is safe; lowering it needs a risk entry. */
export const BENCH_K = 5;
/** An org must have opted in at least this many days before a run (overridable on stage only; never in prod). */
export const BENCH_MIN_OPTIN_DAYS = 30;
/** …and hold at least this many qualifying bookings in the window. */
export const BENCH_MIN_BOOKINGS = 3;
/** The trailing window of bookings a run reads. */
export const BENCH_WINDOW_DAYS = 365;
/** v1 aggregates USD bookings only (RB-G). */
export const BENCH_CURRENCY = "USD";

/** 15 niches: the §1.1 list without `other`. */
export const BENCH_NICHES = [
  "tech",
  "business",
  "finance",
  "marketing",
  "health",
  "food",
  "travel",
  "parenting",
  "education",
  "news_politics",
  "science",
  "gaming",
  "lifestyle",
  "crypto",
  "careers",
] as const satisfies readonly Niche[];
export type BenchNiche = (typeof BENCH_NICHES)[number];

/** 5 fixed audience bands. */
export const BENCH_BANDS = ["lt5k", "5k_15k", "15k_50k", "50k_150k", "150k_plus"] as const;
export type BenchBand = (typeof BENCH_BANDS)[number];

export const BENCH_BAND_LABELS: Record<BenchBand, string> = {
  lt5k: "Under 5k",
  "5k_15k": "5k–15k",
  "15k_50k": "15k–50k",
  "50k_150k": "50k–150k",
  "150k_plus": "150k+",
};

/** 7 formats: the §1.3 list without `other`. */
export const BENCH_FORMATS = [
  "nl_primary",
  "nl_secondary",
  "nl_classified",
  "nl_dedicated",
  "pod_preroll",
  "pod_midroll",
  "pod_postroll",
] as const satisfies readonly SlotFormat[];
export type BenchFormat = (typeof BENCH_FORMATS)[number];

/** The audience band an audience size falls in. Every size ≥ 1 falls in exactly one. */
export function audienceBand(size: number): BenchBand {
  if (size < 5_000) return "lt5k";
  if (size < 15_000) return "5k_15k";
  if (size < 50_000) return "15k_50k";
  if (size < 150_000) return "50k_150k";
  return "150k_plus";
}

/** Contributor bands — published instead of a count. */
export const CONTRIBUTOR_BANDS = ["5–9", "10–24", "25+"] as const;
export type ContributorBand = (typeof CONTRIBUTOR_BANDS)[number];

export function contributorBand(n: number): ContributorBand | null {
  if (n < BENCH_K) return null;
  if (n < 10) return "5–9";
  if (n < 25) return "10–24";
  return "25+";
}

export interface BenchPercentiles {
  p25: number;
  p50: number;
  p75: number;
}

/**
 * A published cell: exactly the design §6.5 fields. Money is USD cents
 * (`flat` = price per slot, `cpm` = price per thousand audience), each
 * percentile rounded to two significant figures.
 */
export interface PublishedBenchCell {
  published: true;
  niche: BenchNiche;
  band: BenchBand;
  format: BenchFormat;
  flat: BenchPercentiles;
  cpm: BenchPercentiles;
  contributors: ContributorBand;
  snapshot: string;
}

/** The answer for any cell that is not published — identical for 0 and k − 1 contributors. */
export interface UnpublishedBenchCell {
  published: false;
}

export type BenchCellResponse = PublishedBenchCell | UnpublishedBenchCell;

export interface BenchCellKey {
  niche: BenchNiche;
  band: BenchBand;
  format: BenchFormat;
  contributors: ContributorBand;
}

export interface BenchCellsResponse {
  /** The ISO week of the latest completed snapshot, or null before the first. */
  snapshot: string | null;
  cells: BenchCellKey[];
}

export interface BenchContribution {
  contributing: boolean;
  optedInAt: string | null;
  revokedAt: string | null;
  /** When the org's bookings first count toward a run (opt-in + the minimum age), or null when not contributing. */
  countsFrom: string | null;
}

export interface BenchContributionResponse {
  contribution: BenchContribution;
  /** Exactly what is shared, for the consent screen. */
  shares: readonly string[];
}

/** What a contributing org shares, word for word on the consent screen. */
export const BENCH_SHARED_FIELDS = [
  "For each live booking of a booked, delivered or paid deal in the last 365 days: the price, the currency, the ad format, and the publication's niche and audience size at booking time.",
  "Never: sponsor names, deal titles, notes, insertion orders, deliveries, or anything about your members.",
  "Your bookings count only once you have been opted in for 30 days and hold at least 3 qualifying (USD) bookings; organizations sharing an owner or admin count as one contributor.",
  "A benchmark is published only where at least 5 independent contributors fall in the same niche, audience band and format, as rounded percentiles and a contributor range — never a count or a row.",
  "Revoke at any time: from the next weekly run your bookings are no longer read.",
] as const;

export const BENCH_EVENT_TYPES = ["bench.contribution.opted_in", "bench.contribution.revoked"] as const;
export type BenchEventType = (typeof BENCH_EVENT_TYPES)[number];
