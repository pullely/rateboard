import {
  DEAL_STAGES,
  DEAL_TRANSITIONS,
  type DealPricing,
  type DealStage,
  type IssueStatus,
  type Niche,
  type PipelineStageSummary,
  type Platform,
  type InsertionOrderStatus,
  type PublicBooking,
  type PublicDelivery,
  type PublicInsertionOrder,
  type PublicReportLink,
  type SponsorReport,
  formatIoNumber,
  type PublicDeal,
  type PublicIssue,
  type PublicPublication,
  type PublicSlot,
  type PublicSponsor,
  type PublicStageChange,
  type PublicationKind,
  type PublicationStatus,
  type ReleaseReason,
  type SlotFormat,
} from "@saas/contracts/deal";
import type {
  Booking,
  Deal,
  Delivery,
  InsertionOrder,
  Issue,
  PublicReport,
  Publication,
  ReportLink,
  Slot,
  Sponsor,
  StageChange,
  StageSummaryRow,
} from "@saas/db/deal";
import {
  bookingPublicId,
  dealPublicId,
  deliveryPublicId,
  insertionOrderPublicId,
  reportLinkPublicId,
  issuePublicId,
  orgPublicId,
  publicationPublicId,
  slotPublicId,
  sponsorPublicId,
} from "./ids.js";

export function toPublicPublication(p: Publication): PublicPublication {
  return {
    id: publicationPublicId(p.id),
    orgId: orgPublicId(p.orgId),
    name: p.name,
    kind: p.kind as PublicationKind,
    niche: p.niche as Niche,
    audienceSize: p.audienceSize,
    platform: p.platform as Platform | null,
    currency: p.currency,
    status: p.status as PublicationStatus,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function toPublicSlot(s: Slot): PublicSlot {
  return {
    id: slotPublicId(s.id),
    issueId: issuePublicId(s.issueId),
    publicationId: publicationPublicId(s.publicationId),
    label: s.label,
    format: s.format as SlotFormat,
    listPriceCents: s.listPriceCents,
    currency: s.currency,
    booking: s.booking
      ? {
          id: bookingPublicId(s.booking.id),
          dealId: dealPublicId(s.booking.dealId),
          dealTitle: s.booking.dealTitle,
          dealStage: s.booking.dealStage as DealStage,
          sponsorId: sponsorPublicId(s.booking.sponsorId),
          sponsorName: s.booking.sponsorName,
          priceCents: s.booking.priceCents,
          currency: s.booking.currency,
        }
      : null,
    createdAt: s.createdAt,
  };
}

export function toPublicIssue(i: Issue, slots: readonly Slot[]): PublicIssue {
  return {
    id: issuePublicId(i.id),
    publicationId: publicationPublicId(i.publicationId),
    publicationName: i.publicationName,
    publicationKind: i.publicationKind as PublicationKind,
    title: i.title,
    publishOn: i.publishOn,
    status: i.status as IssueStatus,
    slots: slots.map(toPublicSlot),
    createdAt: i.createdAt,
  };
}

export function toPublicSponsor(s: Sponsor): PublicSponsor {
  return {
    id: sponsorPublicId(s.id),
    orgId: orgPublicId(s.orgId),
    name: s.name,
    website: s.website,
    contactName: s.contactName,
    contactEmail: s.contactEmail,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toPublicDeal(d: Deal): PublicDeal {
  const stage = d.stage as DealStage;
  return {
    id: dealPublicId(d.id),
    orgId: orgPublicId(d.orgId),
    sponsorId: sponsorPublicId(d.sponsorId),
    sponsorName: d.sponsorName,
    title: d.title,
    stage,
    valueCents: d.valueCents,
    currency: d.currency,
    pricing: d.pricing as DealPricing,
    cpmCents: d.cpmCents,
    notes: d.notes,
    liveBookings: d.liveBookings,
    nextStages: [...DEAL_TRANSITIONS[stage]],
    stageChangedAt: d.stageChangedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function toPublicBooking(b: Booking, delivery: Delivery | null = null): PublicBooking {
  return {
    id: bookingPublicId(b.id),
    dealId: dealPublicId(b.dealId),
    slotId: slotPublicId(b.slotId),
    slotLabel: b.slotLabel,
    issueId: issuePublicId(b.issueId),
    issueTitle: b.issueTitle,
    publishOn: b.publishOn,
    publicationId: publicationPublicId(b.publicationId),
    publicationName: b.publicationName,
    format: b.format as SlotFormat,
    niche: b.niche as Niche,
    audienceSize: b.audienceSize,
    priceCents: b.priceCents,
    currency: b.currency,
    bookedAt: b.bookedAt,
    releasedAt: b.releasedAt,
    releaseReason: b.releaseReason as ReleaseReason | null,
    delivery: delivery ? toPublicDelivery(delivery) : null,
  };
}

export function toPublicDelivery(v: Delivery): PublicDelivery {
  return {
    id: deliveryPublicId(v.id),
    bookingId: bookingPublicId(v.bookingId),
    deliveredOn: v.deliveredOn,
    proofUrl: v.proofUrl,
    opens: v.opens,
    clicks: v.clicks,
    impressions: v.impressions,
    downloads: v.downloads,
    notes: v.notes,
    updatedAt: v.updatedAt,
  };
}

export function toPublicInsertionOrder(o: InsertionOrder): PublicInsertionOrder {
  return {
    id: insertionOrderPublicId(o.id),
    dealId: dealPublicId(o.dealId),
    number: formatIoNumber(o.seq),
    terms: o.terms,
    totalCents: o.totalCents,
    currency: o.currency,
    paymentDueOn: o.paymentDueOn,
    status: o.status as InsertionOrderStatus,
    sendCount: o.sendCount,
    sentAt: o.sentAt,
    sentTo: o.sentTo,
    signedAt: o.signedAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export function toPublicReportLink(l: ReportLink, now: string): PublicReportLink {
  return {
    id: reportLinkPublicId(l.id),
    dealId: dealPublicId(l.dealId),
    expiresAt: l.expiresAt,
    lastViewedAt: l.lastViewedAt,
    viewCount: l.viewCount,
    createdAt: l.createdAt,
    revokedAt: l.revokedAt,
    live: l.revokedAt === null && (l.expiresAt === null || l.expiresAt > now),
  };
}

/** The sponsor's view: exactly the §1.8 fields, built field by field so nothing else can leak in. */
export function toSponsorReport(r: PublicReport): SponsorReport {
  return {
    sponsorName: r.sponsorName,
    dealTitle: r.dealTitle,
    lines: r.lines.map((l) => ({
      publicationName: l.publicationName,
      publicationKind: l.publicationKind as PublicationKind,
      issueTitle: l.issueTitle,
      publishOn: l.publishOn,
      slotLabel: l.slotLabel,
      format: l.format as SlotFormat,
      deliveredOn: l.deliveredOn,
      proofUrl: l.proofUrl,
      opens: l.opens,
      clicks: l.clicks,
      impressions: l.impressions,
      downloads: l.downloads,
    })),
  };
}

export function toPublicStageChange(h: StageChange): PublicStageChange {
  return { fromStage: h.fromStage as DealStage | null, toStage: h.toStage as DealStage, changedAt: h.changedAt };
}

/** Every stage, in pipeline order, even when empty — the board has a column per stage. */
export function toPipeline(rows: readonly StageSummaryRow[]): PipelineStageSummary[] {
  return DEAL_STAGES.map((stage) => {
    const mine = rows.filter((r) => r.stage === stage);
    const valueByCurrency: Record<string, number> = {};
    for (const r of mine) if (r.valueCents > 0) valueByCurrency[r.currency] = (valueByCurrency[r.currency] ?? 0) + r.valueCents;
    return { stage, count: mine.reduce((n, r) => n + r.count, 0), valueByCurrency };
  });
}
