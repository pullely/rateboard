/**
 * Deal (`deal`) bounded context — a creator's sponsor pipeline. Publications
 * (newsletters, podcasts) have dated issues or episodes, each with ad slots;
 * sponsors buy through deals that move lead → pitched → booked → delivered →
 * paid (or lost); a booking is a deal's claim on one slot, and a slot holds at
 * most one live booking. The organization IS the creator's business (or the
 * agency); its members are the people who sell.
 */

export const PUBLICATION_KINDS = ["newsletter", "podcast"] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];

/** A fixed list, never free text: RB3's benchmark cells are keyed by it. */
export const NICHES = [
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
  "other",
] as const;
export type Niche = (typeof NICHES)[number];

export const NICHE_LABELS: Record<Niche, string> = {
  tech: "Tech",
  business: "Business",
  finance: "Finance",
  marketing: "Marketing",
  health: "Health & fitness",
  food: "Food",
  travel: "Travel",
  parenting: "Parenting",
  education: "Education",
  news_politics: "News & politics",
  science: "Science",
  gaming: "Gaming",
  lifestyle: "Lifestyle",
  crypto: "Crypto",
  careers: "Careers",
  other: "Other",
};

export const PLATFORMS = ["beehiiv", "substack", "convertkit", "ghost", "spotify", "apple", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PUBLICATION_STATUSES = ["active", "archived"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const ISSUE_STATUSES = ["scheduled", "published", "cancelled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const SLOT_FORMATS = [
  "nl_primary",
  "nl_secondary",
  "nl_classified",
  "nl_dedicated",
  "pod_preroll",
  "pod_midroll",
  "pod_postroll",
  "other",
] as const;
export type SlotFormat = (typeof SLOT_FORMATS)[number];

export const SLOT_FORMAT_LABELS: Record<SlotFormat, string> = {
  nl_primary: "Primary sponsor",
  nl_secondary: "Secondary sponsor",
  nl_classified: "Classified",
  nl_dedicated: "Dedicated send",
  pod_preroll: "Pre-roll",
  pod_midroll: "Mid-roll",
  pod_postroll: "Post-roll",
  other: "Other",
};

/** Which formats a publication of each kind may sell (`other` fits both). */
export function formatFitsKind(format: SlotFormat, kind: PublicationKind): boolean {
  if (format === "other") return true;
  return kind === "newsletter" ? format.startsWith("nl_") : format.startsWith("pod_");
}

export const DEAL_STAGES = ["lead", "pitched", "booked", "delivered", "paid", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  pitched: "Pitched",
  booked: "Booked",
  delivered: "Delivered",
  paid: "Paid",
  lost: "Lost",
};

/**
 * The pipeline state machine (design §3). Forward one step, `lost` from any
 * open stage before delivery, and `lost → lead` to reopen. No backward moves:
 * a wrong booking is released while the deal is still pitched.
 */
export const DEAL_TRANSITIONS: Record<DealStage, readonly DealStage[]> = {
  lead: ["pitched", "lost"],
  pitched: ["booked", "lost"],
  booked: ["delivered", "lost"],
  delivered: ["paid"],
  paid: [],
  lost: ["lead"],
};

export function canTransition(from: DealStage, to: DealStage): boolean {
  return DEAL_TRANSITIONS[from].includes(to);
}

/** Stages at which a deal may take a new booking. */
export const BOOKABLE_STAGES: readonly DealStage[] = ["lead", "pitched", "booked"];

export const DEAL_PRICING = ["flat", "cpm"] as const;
export type DealPricing = (typeof DEAL_PRICING)[number];

export const RELEASE_REASONS = ["released", "deal_lost"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

/** `error.details.reason` values on a 409 from deal-worker. */
export const DEAL_CONFLICT_REASONS = [
  "slot_already_booked",
  "deal_not_bookable",
  "issue_cancelled",
  "stage_conflict",
  "no_bookings",
  "last_booking",
  "already_released",
  "duplicate_name",
] as const;
export type DealConflictReason = (typeof DEAL_CONFLICT_REASONS)[number];

export const DEAL_EVENT_TYPES = [
  "deal.publication.created",
  "deal.publication.updated",
  "deal.issue.created",
  "deal.slot.created",
  "deal.sponsor.created",
  "deal.sponsor.updated",
  "deal.created",
  "deal.updated",
  "deal.stage.changed",
  "deal.booking.created",
  "deal.booking.refused",
  "deal.booking.released",
] as const;
export type DealEventType = (typeof DEAL_EVENT_TYPES)[number];

/** The calendar never spans more than this many days in one read. */
export const INVENTORY_MAX_DAYS = 92;
export const INVENTORY_DEFAULT_DAYS = 56;
/** Slots created inline with an issue. */
export const ISSUE_MAX_INLINE_SLOTS = 12;

// ── Wire shapes ─────────────────────────────────────────────

export interface PublicPublication {
  id: string;
  orgId: string;
  name: string;
  kind: PublicationKind;
  niche: Niche;
  audienceSize: number;
  platform: Platform | null;
  currency: string;
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSlotBooking {
  id: string;
  dealId: string;
  dealTitle: string;
  dealStage: DealStage;
  sponsorId: string;
  sponsorName: string;
  priceCents: number;
  currency: string;
}

export interface PublicSlot {
  id: string;
  issueId: string;
  publicationId: string;
  label: string;
  format: SlotFormat;
  listPriceCents: number | null;
  currency: string;
  /** The live booking, or null when the slot is open. */
  booking: PublicSlotBooking | null;
  createdAt: string;
}

export interface PublicIssue {
  id: string;
  publicationId: string;
  publicationName: string;
  publicationKind: PublicationKind;
  title: string;
  publishOn: string;
  status: IssueStatus;
  slots: PublicSlot[];
  createdAt: string;
}

export interface PublicSponsor {
  id: string;
  orgId: string;
  name: string;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDeal {
  id: string;
  orgId: string;
  sponsorId: string;
  sponsorName: string;
  title: string;
  stage: DealStage;
  valueCents: number | null;
  currency: string;
  pricing: DealPricing;
  cpmCents: number | null;
  notes: string;
  liveBookings: number;
  /** The stages this deal may move to next (design §3). */
  nextStages: DealStage[];
  stageChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicBooking {
  id: string;
  dealId: string;
  slotId: string;
  slotLabel: string;
  issueId: string;
  issueTitle: string;
  publishOn: string;
  publicationId: string;
  publicationName: string;
  format: SlotFormat;
  niche: Niche;
  audienceSize: number;
  priceCents: number;
  currency: string;
  bookedAt: string;
  releasedAt: string | null;
  releaseReason: ReleaseReason | null;
}

export interface PublicStageChange {
  fromStage: DealStage | null;
  toStage: DealStage;
  changedAt: string;
}

export interface PipelineStageSummary {
  stage: DealStage;
  count: number;
  /** Sum of value_cents per currency, for deals with a value. */
  valueByCurrency: Record<string, number>;
}

// Requests
export interface CreatePublicationRequest {
  name: string;
  kind: PublicationKind;
  niche: Niche;
  audienceSize: number;
  platform?: Platform | null;
  currency?: string;
}
export type UpdatePublicationRequest = Partial<CreatePublicationRequest> & { status?: PublicationStatus };

export interface CreateSlotRequest {
  label: string;
  format: SlotFormat;
  listPriceCents?: number | null;
  currency?: string;
}

export interface CreateIssueRequest {
  title: string;
  publishOn: string;
  slots?: CreateSlotRequest[];
}

export interface CreateSponsorRequest {
  name: string;
  website?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  notes?: string;
}
export type UpdateSponsorRequest = Partial<CreateSponsorRequest>;

export interface CreateDealRequest {
  /** An existing sponsor… */
  sponsorId?: string;
  /** …or a new one by name (created, or matched case-insensitively). */
  sponsorName?: string;
  title: string;
  valueCents?: number | null;
  currency?: string;
  pricing?: DealPricing;
  cpmCents?: number | null;
  notes?: string;
}
export type UpdateDealRequest = Partial<Omit<CreateDealRequest, "sponsorId" | "sponsorName">>;

export interface MoveDealStageRequest {
  to: DealStage;
  /** The stage the caller believes the deal is in; a mismatch is 409 stage_conflict. */
  from?: DealStage;
}

export interface CreateBookingRequest {
  slotId: string;
  /** Defaults to the slot's list price; required when the slot has none. */
  priceCents?: number;
}

// Responses (the `data` of the envelope)
export interface PublicationResponse {
  publication: PublicPublication;
}
export interface ListPublicationsResponse {
  publications: PublicPublication[];
}
export interface IssueResponse {
  issue: PublicIssue;
}
export interface SlotResponse {
  slot: PublicSlot;
}
export interface InventoryResponse {
  from: string;
  to: string;
  issues: PublicIssue[];
}
export interface SponsorResponse {
  sponsor: PublicSponsor;
}
export interface GetSponsorResponse {
  sponsor: PublicSponsor;
  deals: PublicDeal[];
}
export interface ListSponsorsResponse {
  sponsors: PublicSponsor[];
}
export interface DealResponse {
  deal: PublicDeal;
}
export interface GetDealResponse {
  deal: PublicDeal;
  bookings: PublicBooking[];
  history: PublicStageChange[];
}
export interface ListDealsResponse {
  deals: PublicDeal[];
}
export interface BookingResponse {
  booking: PublicBooking;
  deal: PublicDeal;
}
export interface PipelineResponse {
  stages: PipelineStageSummary[];
}
