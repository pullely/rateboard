// Deal (deal) bounded context — row shapes and repository seam.
//
// Timestamps are ISO-8601 strings and dates are YYYY-MM-DD strings end to end:
// D1 stores TEXT, the wire carries strings, and a string comparison of two
// such dates is a date comparison. Money is integer minor units + currency.
//
// Every function takes orgId and scopes by it. Every write whose outcome the
// caller branches on reports it through RETURNING rows, never rowCount — the
// D1 executor reports rowCount = rows.length, so a write without RETURNING
// always says 0 (runbook trap 22).

export interface Publication {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  niche: string;
  audienceSize: number;
  platform: string | null;
  currency: string;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationFields {
  name: string;
  kind: string;
  niche: string;
  audienceSize: number;
  platform: string | null;
  currency: string;
  status: string;
}

export interface Issue {
  id: string;
  orgId: string;
  publicationId: string;
  publicationName: string;
  publicationKind: string;
  title: string;
  publishOn: string;
  status: string;
  createdAt: string;
}

export interface SlotBookingSummary {
  id: string;
  dealId: string;
  dealTitle: string;
  dealStage: string;
  sponsorId: string;
  sponsorName: string;
  priceCents: number;
  currency: string;
}

export interface Slot {
  id: string;
  orgId: string;
  issueId: string;
  publicationId: string;
  label: string;
  format: string;
  listPriceCents: number | null;
  currency: string;
  createdAt: string;
  /** The live booking, when the query joined it; null when the slot is open. */
  booking: SlotBookingSummary | null;
}

export interface SlotFields {
  label: string;
  format: string;
  listPriceCents: number | null;
  currency: string;
}

export interface Sponsor {
  id: string;
  orgId: string;
  name: string;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SponsorFields {
  name: string;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  notes: string;
}

export interface Deal {
  id: string;
  orgId: string;
  sponsorId: string;
  sponsorName: string;
  title: string;
  stage: string;
  valueCents: number | null;
  currency: string;
  pricing: string;
  cpmCents: number | null;
  notes: string;
  liveBookings: number;
  stageChangedAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealFields {
  title: string;
  valueCents: number | null;
  currency: string;
  pricing: string;
  cpmCents: number | null;
  notes: string;
}

export interface Booking {
  id: string;
  orgId: string;
  dealId: string;
  slotId: string;
  slotLabel: string;
  issueId: string;
  issueTitle: string;
  publishOn: string;
  publicationId: string;
  publicationName: string;
  format: string;
  niche: string;
  audienceSize: number;
  priceCents: number;
  currency: string;
  bookedBy: string | null;
  bookedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface StageChange {
  id: string;
  dealId: string;
  fromStage: string | null;
  toStage: string;
  changedBy: string | null;
  changedAt: string;
}

export interface StageSummaryRow {
  stage: string;
  currency: string;
  count: number;
  valueCents: number;
}

/** Why a booking claim inserted nothing — read after the fact, for the error. */
export interface ClaimContext {
  dealStage: string | null;
  slotExists: boolean;
  issueStatus: string | null;
  liveBooking: { id: string; dealId: string } | null;
}

export interface ClaimBookingInput {
  id: string;
  orgId: string;
  dealId: string;
  slotId: string;
  /** null = use the slot's list price. */
  priceCents: number | null;
  bookedBy: string | null;
  now: string;
}

export interface MoveStageInput {
  orgId: string;
  dealId: string;
  from: string;
  to: string;
  now: string;
  /** `booked` needs at least one live booking; the check is inside the UPDATE. */
  requireLiveBooking: boolean;
}

export interface DealRepository {
  createPublication(input: PublicationFields & { id: string; orgId: string; createdBy: string | null; now: string }): Promise<Publication | null>;
  getPublication(orgId: string, id: string): Promise<Publication | null>;
  listPublications(orgId: string, status?: string): Promise<Publication[]>;
  /** null when no such publication — or its new name collides (the caller has read it first). */
  updatePublication(orgId: string, id: string, fields: PublicationFields, now: string): Promise<Publication | null>;

  /** null when the publication already has an issue with that title. */
  createIssue(input: { id: string; orgId: string; publicationId: string; title: string; publishOn: string; createdBy: string | null; now: string }): Promise<Issue | null>;
  getIssue(orgId: string, id: string): Promise<Issue | null>;
  /** null when the issue already has a slot with that label. */
  createSlot(input: SlotFields & { id: string; orgId: string; issueId: string; publicationId: string; createdBy: string | null; now: string }): Promise<Slot | null>;
  getSlot(orgId: string, id: string): Promise<Slot | null>;
  listSlotsForIssue(orgId: string, issueId: string): Promise<Slot[]>;
  listIssuesInRange(orgId: string, from: string, to: string, publicationId?: string): Promise<Issue[]>;
  listSlotsInRange(orgId: string, from: string, to: string, publicationId?: string): Promise<Slot[]>;

  createSponsor(input: SponsorFields & { id: string; orgId: string; createdBy: string | null; now: string }): Promise<Sponsor | null>;
  getSponsor(orgId: string, id: string): Promise<Sponsor | null>;
  findSponsorByName(orgId: string, name: string): Promise<Sponsor | null>;
  listSponsors(orgId: string): Promise<Sponsor[]>;
  updateSponsor(orgId: string, id: string, fields: SponsorFields, now: string): Promise<Sponsor | null>;

  createDeal(input: DealFields & { id: string; orgId: string; sponsorId: string; createdBy: string | null; now: string }): Promise<Deal>;
  getDeal(orgId: string, id: string): Promise<Deal | null>;
  listDeals(orgId: string, filter: { stage?: string; sponsorId?: string }): Promise<Deal[]>;
  updateDeal(orgId: string, id: string, fields: DealFields, now: string): Promise<Deal | null>;
  /** The conditional stage move. null = the deal was not at `from` (or had no live booking when required). */
  moveStage(input: MoveStageInput): Promise<Deal | null>;
  appendStageHistory(input: { id: string; orgId: string; dealId: string; fromStage: string | null; toStage: string; changedBy: string | null; now: string }): Promise<void>;
  listStageHistory(orgId: string, dealId: string): Promise<StageChange[]>;
  pipelineSummary(orgId: string): Promise<StageSummaryRow[]>;

  /**
   * The one-statement booking claim (design §2). Returns the new booking's id,
   * or null when nothing was inserted: the slot already has a live booking, the
   * deal is not bookable, the issue is cancelled, or the deal/slot is not in
   * this org. `claimContext` then says which.
   */
  claimBooking(input: ClaimBookingInput): Promise<string | null>;
  claimContext(orgId: string, dealId: string, slotId: string): Promise<ClaimContext>;
  getBooking(orgId: string, id: string): Promise<Booking | null>;
  listBookingsForDeal(orgId: string, dealId: string): Promise<Booking[]>;
  /**
   * Release one live booking: allowed while the deal is lead/pitched, and while
   * it is booked only if another live booking remains. null = refused or absent.
   */
  releaseBooking(input: { orgId: string; dealId: string; bookingId: string; releasedBy: string | null; now: string }): Promise<Booking | null>;
  /** Release every live booking of a deal (it was lost). Returns the released ids. */
  releaseAllForDeal(input: { orgId: string; dealId: string; releasedBy: string | null; now: string }): Promise<string[]>;
}
