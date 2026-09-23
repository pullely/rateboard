import { PUBLICATION_STATUSES, formatFitsKind, type PublicationKind } from "@saas/contracts/deal";
import type { Slot } from "@saas/db/deal";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { notFound, successResponse, validationError } from "../http.js";
import { actorSubjectUuid, issuePublicId, publicationPublicId, slotPublicId } from "../ids.js";
import { toPublicIssue, toPublicPublication, toPublicSlot } from "../present.js";
import { validateIssueBody, validatePublicationBody, validateSlotBody, type SlotInput } from "../validate.js";
import { audit, conflict, invalidJson, readJson, withDb } from "./common.js";

export async function handleListPublications(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  if (status !== undefined && !(PUBLICATION_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`One of ${PUBLICATION_STATUSES.join(", ")}`] });
  }
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const publications = await db.deals.listPublications(orgId, status);
    return successResponse({ publications: publications.map(toPublicPublication) }, requestId);
  });
}

export async function handleCreatePublication(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validatePublicationBody(parsed.body, null);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const pub = await db.deals.createPublication({ id: crypto.randomUUID(), orgId, ...v.value, createdBy: actorSubjectUuid(actor.subjectId), now });
    if (!pub) return conflict(requestId, "duplicate_name", `A publication named "${v.value.name}" already exists`);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.publication.created",
      kind: "publication",
      subjectId: pub.id,
      subjectName: pub.name,
      description: `Added the ${pub.kind} "${pub.name}" (${pub.niche}, audience ${pub.audienceSize})`,
      payload: { publicationId: publicationPublicId(pub.id), kind: pub.kind, niche: pub.niche, audienceSize: pub.audienceSize },
    });
    return successResponse({ publication: toPublicPublication(pub) }, requestId, 201);
  });
}

export async function handleGetPublication(env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const pub = await db.deals.getPublication(orgId, id);
    if (!pub) return notFound(requestId);
    return successResponse({ publication: toPublicPublication(pub) }, requestId);
  });
}

export async function handleUpdatePublication(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const current = await db.deals.getPublication(orgId, id);
    if (!current) return notFound(requestId);
    const v = validatePublicationBody(parsed.body, current);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const pub = await db.deals.updatePublication(orgId, id, v.value, now);
    // The row exists (read above), so no row back means the rename collided.
    if (!pub) return conflict(requestId, "duplicate_name", `A publication named "${v.value.name}" already exists`);
    const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => v.value[k] !== current[k]);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.publication.updated",
      kind: "publication",
      subjectId: pub.id,
      subjectName: pub.name,
      description: `Updated the publication "${pub.name}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      payload: { publicationId: publicationPublicId(pub.id), changed },
    });
    return successResponse({ publication: toPublicPublication(pub) }, requestId);
  });
}

function formatMismatch(slot: SlotInput, kind: string, field: string): Record<string, string[]> | null {
  return formatFitsKind(slot.format, kind as PublicationKind)
    ? null
    : { [field]: [`A ${kind} cannot sell the format ${slot.format}`] };
}

/** POST publications/{rbp}/issues — an issue or episode, optionally with its slots. */
export async function handleCreateIssue(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, publicationId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const pub = await db.deals.getPublication(orgId, publicationId);
    if (!pub) return notFound(requestId);
    const v = validateIssueBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    for (const [i, slot] of v.value.slots.entries()) {
      const bad = formatMismatch(slot, pub.kind, `slots.${i}.format`);
      if (bad) return validationError(requestId, bad);
    }
    const now = nowIso();
    const createdBy = actorSubjectUuid(actor.subjectId);
    const issue = await db.deals.createIssue({ id: crypto.randomUUID(), orgId, publicationId, title: v.value.title, publishOn: v.value.publishOn, createdBy, now });
    if (!issue) return conflict(requestId, "duplicate_name", `"${pub.name}" already has an issue titled "${v.value.title}"`);
    const slots: Slot[] = [];
    for (const s of v.value.slots) {
      const slot = await db.deals.createSlot({
        id: crypto.randomUUID(), orgId, issueId: issue.id, publicationId, label: s.label, format: s.format,
        listPriceCents: s.listPriceCents, currency: s.currency ?? pub.currency, createdBy, now,
      });
      if (slot) slots.push(slot);
    }
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.issue.created",
      kind: "issue",
      subjectId: issue.id,
      subjectName: `${pub.name} — ${issue.title}`,
      description: `Scheduled "${issue.title}" of ${pub.name} for ${issue.publishOn} with ${slots.length} slot(s)`,
      payload: {
        issueId: issuePublicId(issue.id),
        publicationId: publicationPublicId(pub.id),
        publishOn: issue.publishOn,
        slots: slots.map((s) => ({ slotId: slotPublicId(s.id), label: s.label, format: s.format, listPriceCents: s.listPriceCents })),
      },
    });
    return successResponse({ issue: toPublicIssue(issue, slots) }, requestId, 201);
  });
}

/** POST issues/{rbi}/slots */
export async function handleCreateSlot(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, issueId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const issue = await db.deals.getIssue(orgId, issueId);
    if (!issue) return notFound(requestId);
    const v = validateSlotBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const bad = formatMismatch(v.value, issue.publicationKind, "format");
    if (bad) return validationError(requestId, bad);
    const pub = await db.deals.getPublication(orgId, issue.publicationId);
    const now = nowIso();
    const slot = await db.deals.createSlot({
      id: crypto.randomUUID(), orgId, issueId, publicationId: issue.publicationId, label: v.value.label, format: v.value.format,
      listPriceCents: v.value.listPriceCents, currency: v.value.currency ?? pub?.currency ?? "USD",
      createdBy: actorSubjectUuid(actor.subjectId), now,
    });
    if (!slot) return conflict(requestId, "duplicate_name", `"${issue.title}" already has a slot labelled "${v.value.label}"`);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.slot.created",
      kind: "slot",
      subjectId: slot.id,
      subjectName: `${issue.title} — ${slot.label}`,
      description: `Added the ${slot.format} slot "${slot.label}" to "${issue.title}"`,
      payload: { slotId: slotPublicId(slot.id), issueId: issuePublicId(issue.id), format: slot.format, listPriceCents: slot.listPriceCents },
    });
    return successResponse({ slot: toPublicSlot(slot) }, requestId, 201);
  });
}
