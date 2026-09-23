import { DEAL_STAGES, DEAL_STAGE_LABELS, canTransition, type DealStage } from "@saas/contracts/deal";
import type { Sponsor } from "@saas/db/deal";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { notFound, successResponse, validationError } from "../http.js";
import { actorSubjectUuid, bookingPublicId, dealPublicId, parseSponsorPublicId, sponsorPublicId } from "../ids.js";
import { toPipeline, toPublicBooking, toPublicDeal, toPublicStageChange } from "../present.js";
import { validateDealCreate, validateDealPatch, validateStageMove } from "../validate.js";
import { audit, conflict, formatMoney, invalidJson, readJson, withDb } from "./common.js";

export async function handleListDeals(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const stage = new URL(request.url).searchParams.get("stage") ?? undefined;
  if (stage !== undefined && !(DEAL_STAGES as readonly string[]).includes(stage)) {
    return validationError(requestId, { stage: [`One of ${DEAL_STAGES.join(", ")}`] });
  }
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const deals = await db.deals.listDeals(orgId, stage ? { stage } : {});
    return successResponse({ deals: deals.map(toPublicDeal) }, requestId);
  });
}

export async function handleCreateDeal(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateDealCreate(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const createdBy = actorSubjectUuid(actor.subjectId);

    let sponsor: Sponsor | null = null;
    if (v.value.sponsorId) {
      const id = parseSponsorPublicId(v.value.sponsorId);
      sponsor = id ? await db.deals.getSponsor(orgId, id) : null;
      if (!sponsor) return validationError(requestId, { sponsorId: ["No such sponsor in this organization"] });
    } else {
      const name = v.value.sponsorName!;
      sponsor = await db.deals.findSponsorByName(orgId, name);
      if (!sponsor) {
        sponsor = await db.deals.createSponsor({
          id: crypto.randomUUID(), orgId, name, website: null, contactName: null, contactEmail: null, notes: "", createdBy, now,
        });
        // Lost a race with a teammate creating the same sponsor: use theirs.
        sponsor ??= await db.deals.findSponsorByName(orgId, name);
        if (!sponsor) throw new Error("sponsor create-or-find failed");
        if (sponsor.createdAt === now) {
          await audit(db, actor, requestId, orgId, now, {
            type: "deal.sponsor.created",
            kind: "sponsor",
            subjectId: sponsor.id,
            subjectName: sponsor.name,
            description: `Added the sponsor "${sponsor.name}"`,
            payload: { sponsorId: sponsorPublicId(sponsor.id) },
          });
        }
      }
    }

    const deal = await db.deals.createDeal({
      id: crypto.randomUUID(),
      orgId,
      sponsorId: sponsor.id,
      title: v.value.title,
      valueCents: v.value.valueCents,
      currency: v.value.currency,
      pricing: v.value.pricing,
      cpmCents: v.value.cpmCents,
      notes: v.value.notes,
      createdBy,
      now,
    });
    await db.deals.appendStageHistory({ id: crypto.randomUUID(), orgId, dealId: deal.id, fromStage: null, toStage: "lead", changedBy: createdBy, now });
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.created",
      kind: "deal",
      subjectId: deal.id,
      subjectName: deal.title,
      description: `Logged the lead "${deal.title}" with ${sponsor.name} (${formatMoney(deal.valueCents, deal.currency)})`,
      payload: { dealId: dealPublicId(deal.id), sponsorId: sponsorPublicId(sponsor.id), valueCents: deal.valueCents, currency: deal.currency, pricing: deal.pricing },
    });
    return successResponse({ deal: toPublicDeal(deal) }, requestId, 201);
  });
}

export async function handleGetDeal(env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const deal = await db.deals.getDeal(orgId, id);
    if (!deal) return notFound(requestId);
    const [bookings, history] = await Promise.all([db.deals.listBookingsForDeal(orgId, id), db.deals.listStageHistory(orgId, id)]);
    return successResponse(
      { deal: toPublicDeal(deal), bookings: bookings.map(toPublicBooking), history: history.map(toPublicStageChange) },
      requestId,
    );
  });
}

export async function handleUpdateDeal(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const current = await db.deals.getDeal(orgId, id);
    if (!current) return notFound(requestId);
    const v = validateDealPatch(parsed.body, current);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const deal = await db.deals.updateDeal(orgId, id, v.value, now);
    if (!deal) return notFound(requestId);
    const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => v.value[k] !== current[k]);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.updated",
      kind: "deal",
      subjectId: deal.id,
      subjectName: deal.title,
      description: `Updated the deal "${deal.title}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      payload: { dealId: dealPublicId(deal.id), changed, valueCents: deal.valueCents, currency: deal.currency },
    });
    return successResponse({ deal: toPublicDeal(deal) }, requestId);
  });
}

/** POST deals/{rbd}/stage — one move through the state machine (design §3). */
export async function handleMoveStage(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateStageMove(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const current = await db.deals.getDeal(orgId, id);
    if (!current) return notFound(requestId);
    const from = (v.value.from ?? current.stage) as DealStage;
    const to = v.value.to;
    if (!canTransition(from, to)) {
      return validationError(requestId, { to: [`A deal cannot move from ${from} to ${to}`] });
    }
    const now = nowIso();
    const changedBy = actorSubjectUuid(actor.subjectId);
    const moved = await db.deals.moveStage({ orgId, dealId: id, from, to, now, requireLiveBooking: to === "booked" });
    if (!moved) {
      const latest = await db.deals.getDeal(orgId, id);
      if (!latest) return notFound(requestId);
      if (latest.stage !== from) {
        return conflict(requestId, "stage_conflict", `The deal is ${latest.stage}, not ${from}`, { currentStage: latest.stage });
      }
      return conflict(requestId, "no_bookings", "Book at least one slot before marking the deal booked");
    }
    let released: string[] = [];
    if (to === "lost") released = await db.deals.releaseAllForDeal({ orgId, dealId: id, releasedBy: changedBy, now });
    await db.deals.appendStageHistory({ id: crypto.randomUUID(), orgId, dealId: id, fromStage: from, toStage: to, changedBy, now });
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.stage.changed",
      kind: "deal",
      subjectId: id,
      subjectName: moved.title,
      description: `Moved "${moved.title}" from ${DEAL_STAGE_LABELS[from]} to ${DEAL_STAGE_LABELS[to]}${
        released.length ? `, releasing ${released.length} slot(s)` : ""
      }`,
      payload: { dealId: dealPublicId(id), from, to, releasedBookings: released.map(bookingPublicId) },
    });
    const deal = released.length ? ((await db.deals.getDeal(orgId, id)) ?? moved) : moved;
    return successResponse({ deal: toPublicDeal(deal) }, requestId);
  });
}

export async function handlePipeline(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    return successResponse({ stages: toPipeline(await db.deals.pipelineSummary(orgId)) }, requestId);
  });
}

