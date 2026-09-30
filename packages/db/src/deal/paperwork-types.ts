// Deal context, RB2 — insertion orders, deliveries and sponsor report links.
// Same conventions as types.ts: every function takes orgId (except the public
// report lookup, which is keyed by a token hash), and every write the caller
// branches on reports through RETURNING rows (runbook trap 22).

export interface InsertionOrder {
  id: string;
  orgId: string;
  dealId: string;
  seq: number;
  terms: string;
  totalCents: number;
  currency: string;
  paymentDueOn: string | null;
  status: string;
  sendCount: number;
  sentAt: string | null;
  sentTo: string | null;
  notificationId: string | null;
  signedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertionOrderFields {
  terms: string;
  totalCents: number;
  paymentDueOn: string | null;
}

export interface CreateInsertionOrderInput {
  id: string;
  orgId: string;
  dealId: string;
  terms: string;
  /** null = the sum of the deal's live bookings. */
  totalCents: number | null;
  paymentDueOn: string | null;
  createdBy: string | null;
  now: string;
}

export interface Delivery {
  id: string;
  orgId: string;
  dealId: string;
  bookingId: string;
  deliveredOn: string;
  proofUrl: string | null;
  opens: number | null;
  clicks: number | null;
  impressions: number | null;
  downloads: number | null;
  notes: string;
  recordedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryFields {
  deliveredOn: string;
  proofUrl: string | null;
  opens: number | null;
  clicks: number | null;
  impressions: number | null;
  downloads: number | null;
  notes: string;
}

export interface ReportLink {
  id: string;
  orgId: string;
  dealId: string;
  expiresAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** One delivered slot on the public report — no price, no notes, no member identity. */
export interface ReportLine {
  publicationName: string;
  publicationKind: string;
  issueTitle: string;
  publishOn: string;
  slotLabel: string;
  format: string;
  deliveredOn: string;
  proofUrl: string | null;
  opens: number | null;
  clicks: number | null;
  impressions: number | null;
  downloads: number | null;
}

export interface PublicReport {
  sponsorName: string;
  dealTitle: string;
  lines: ReportLine[];
}

export interface PaperworkRepository {
  /**
   * Claim the next per-org IO number and insert the IO in one statement
   * (`INSERT … SELECT COALESCE(MAX(seq), 0) + 1 … ON CONFLICT DO NOTHING
   * RETURNING`). null = nothing inserted: the deal already has an IO, it is
   * not booked yet, it is absent, or (on a platform that interleaves
   * statements) the number was taken — the caller retries once.
   */
  createInsertionOrder(input: CreateInsertionOrderInput): Promise<InsertionOrder | null>;
  getInsertionOrder(orgId: string, dealId: string): Promise<InsertionOrder | null>;
  /** null = absent or already signed. */
  updateInsertionOrder(orgId: string, dealId: string, fields: InsertionOrderFields, now: string): Promise<InsertionOrder | null>;
  /** draft|sent → signed. null = absent or already signed. */
  signInsertionOrder(orgId: string, dealId: string, now: string): Promise<InsertionOrder | null>;
  /** Record an accepted send. `expectedSendCount` guards against a racing send. null = lost the race or signed. */
  markInsertionOrderSent(input: { orgId: string; dealId: string; expectedSendCount: number; sentTo: string; notificationId: string; now: string }): Promise<InsertionOrder | null>;

  /**
   * Create or replace the delivery of one LIVE booking of a deal that is
   * booked, delivered or paid. null = the booking is not live in this deal, or
   * the deal is not at a stage that delivers.
   */
  upsertDelivery(input: DeliveryFields & { id: string; orgId: string; dealId: string; bookingId: string; recordedBy: string | null; now: string }): Promise<Delivery | null>;
  listDeliveriesForDeal(orgId: string, dealId: string): Promise<Delivery[]>;
  /** Live bookings of the deal that have no delivery yet. */
  countUndeliveredBookings(orgId: string, dealId: string): Promise<number>;

  /** null = the deal is absent, or it already has a live link. */
  createReportLink(input: { id: string; orgId: string; dealId: string; tokenSha256: string; expiresAt: string | null; createdBy: string | null; now: string }): Promise<ReportLink | null>;
  listReportLinks(orgId: string, dealId: string): Promise<ReportLink[]>;
  getReportLink(orgId: string, dealId: string, id: string): Promise<ReportLink | null>;
  /** null = absent or already revoked. */
  revokeReportLink(input: { orgId: string; dealId: string; id: string; revokedBy: string | null; now: string }): Promise<ReportLink | null>;
  /**
   * The public lookup: a live, unexpired link by token hash, stamped as viewed
   * in the same statement. null for unknown, revoked and expired alike.
   */
  openReportLink(tokenSha256: string, now: string): Promise<{ orgId: string; dealId: string } | null>;
  /** The report body — only what a sponsor may see. */
  readReport(orgId: string, dealId: string): Promise<PublicReport | null>;
}
