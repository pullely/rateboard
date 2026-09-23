import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { notFound, successResponse, validationError } from "../http.js";
import { actorSubjectUuid, sponsorPublicId } from "../ids.js";
import { toPublicDeal, toPublicSponsor } from "../present.js";
import { validateSponsorBody } from "../validate.js";
import { audit, conflict, invalidJson, readJson, withDb } from "./common.js";

export async function handleListSponsors(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const sponsors = await db.deals.listSponsors(orgId);
    return successResponse({ sponsors: sponsors.map(toPublicSponsor) }, requestId);
  });
}

export async function handleCreateSponsor(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateSponsorBody(parsed.body, null);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const sponsor = await db.deals.createSponsor({ id: crypto.randomUUID(), orgId, ...v.value, createdBy: actorSubjectUuid(actor.subjectId), now });
    if (!sponsor) return conflict(requestId, "duplicate_name", `A sponsor named "${v.value.name}" already exists`);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.sponsor.created",
      kind: "sponsor",
      subjectId: sponsor.id,
      subjectName: sponsor.name,
      description: `Added the sponsor "${sponsor.name}"`,
      payload: { sponsorId: sponsorPublicId(sponsor.id) },
    });
    return successResponse({ sponsor: toPublicSponsor(sponsor) }, requestId, 201);
  });
}

export async function handleGetSponsor(env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const sponsor = await db.deals.getSponsor(orgId, id);
    if (!sponsor) return notFound(requestId);
    const deals = await db.deals.listDeals(orgId, { sponsorId: id });
    return successResponse({ sponsor: toPublicSponsor(sponsor), deals: deals.map(toPublicDeal) }, requestId);
  });
}

export async function handleUpdateSponsor(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const current = await db.deals.getSponsor(orgId, id);
    if (!current) return notFound(requestId);
    const v = validateSponsorBody(parsed.body, current);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const sponsor = await db.deals.updateSponsor(orgId, id, v.value, now);
    if (!sponsor) return conflict(requestId, "duplicate_name", `A sponsor named "${v.value.name}" already exists`);
    const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => v.value[k] !== current[k]);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.sponsor.updated",
      kind: "sponsor",
      subjectId: sponsor.id,
      subjectName: sponsor.name,
      description: `Updated the sponsor "${sponsor.name}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      // Field names only: contact details stay out of the audit payload.
      payload: { sponsorId: sponsorPublicId(sponsor.id), changed },
    });
    return successResponse({ sponsor: toPublicSponsor(sponsor) }, requestId);
  });
}
