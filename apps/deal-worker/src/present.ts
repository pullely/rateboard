import {
  DEAL_STAGES,
  DEAL_TRANSITIONS,
  type DealPricing,
  type DealStage,
  type IssueStatus,
  type Niche,
  type PipelineStageSummary,
  type Platform,
  type PublicBooking,
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
import type { Booking, Deal, Issue, Publication, Slot, Sponsor, StageChange, StageSummaryRow } from "@saas/db/deal";
import {
  bookingPublicId,
  dealPublicId,
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

export function toPublicBooking(b: Booking): PublicBooking {
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
