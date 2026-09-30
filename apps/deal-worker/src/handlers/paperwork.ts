import { DEAL_IO_TEMPLATE_KEY, SLOT_FORMAT_LABELS, formatIoNumber, type SlotFormat } from "@saas/contracts/deal";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { errorResponse, notFound, successResponse, validationError } from "../http.js";
import {
  actorSubjectUuid,
  bookingPublicId,
  dealPublicId,
  deliveryPublicId,
  insertionOrderPublicId,
  reportLinkPublicId,
} from "../ids.js";
import { enqueueEmail } from "../notify.js";
import { toPublicDelivery, toPublicInsertionOrder, toPublicReportLink } from "../present.js";
import { newReportToken, sha256Hex } from "../tokens.js";
import { validateDeliveryBody, validateIoCreate, validateIoPatch, validateReportLinkBody } from "../validate.js";
import { audit, conflict, formatMoney, invalidJson, readJson, withDb } from "./common.js";

const ISSUABLE = new Set(["booked", "delivered", "paid"]);

// ── insertion orders ───────────────────────────────────────

/**
 * POST deals/{rbd}/insertion-order — the deal's one IO, numbered per org.
 * The number is claimed inside the INSERT under UNIQUE (org_id, seq); a
 * no-row answer is read for its reason, and a lost number race is retried
 * once (design §1.8).
 */
export async function handleCreateInsertionOrder(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  const parsed = await readOptionalJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateIoCreate(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    const now = nowIso();
    const createdBy = actorSubjectUuid(actor.subjectId);
    let io = null;
    for (let attempt = 0; attempt < 2 && !io; attempt++) {
      io = await db.paperwork.createInsertionOrder({ id: crypto.randomUUID(), orgId, dealId, ...v.value, createdBy, now });
      if (io) break;
      const existing = await db.paperwork.getInsertionOrder(orgId, dealId);
      if (existing) {
        return conflict(requestId, "insertion_order_exists", `"${deal.title}" already has ${formatIoNumber(existing.seq)}`, {
          insertionOrderId: insertionOrderPublicId(existing.id),
        });
      }
      const latest = await db.deals.getDeal(orgId, dealId);
      if (!latest) return notFound(requestId);
      if (!ISSUABLE.has(latest.stage)) {
        return conflict(requestId, "deal_not_booked", `Issue an insertion order once the deal is booked (it is ${latest.stage})`, {
          currentStage: latest.stage,
        });
      }
      // Otherwise the per-org number was taken between the MAX and the insert: retry once.
    }
    if (!io) return errorResponse("internal_error", "Could not number the insertion order; try again", 503, requestId);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.io.created",
      kind: "insertion_order",
      subjectId: io.id,
      subjectName: formatIoNumber(io.seq),
      description: `Drew up ${formatIoNumber(io.seq)} for "${deal.title}" (${formatMoney(io.totalCents, io.currency)})`,
      payload: { insertionOrderId: insertionOrderPublicId(io.id), dealId: dealPublicId(dealId), number: formatIoNumber(io.seq), totalCents: io.totalCents, currency: io.currency },
    });
    return successResponse({ insertionOrder: toPublicInsertionOrder(io) }, requestId, 201);
  });
}

export async function handleGetInsertionOrder(env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const io = await db.paperwork.getInsertionOrder(orgId, dealId);
    if (!io) return notFound(requestId);
    return successResponse({ insertionOrder: toPublicInsertionOrder(io) }, requestId);
  });
}

/** PATCH deals/{rbd}/insertion-order — edit the terms, total or due date, or record the signature by hand. */
export async function handleUpdateInsertionOrder(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const current = await db.paperwork.getInsertionOrder(orgId, dealId);
    if (!current) return notFound(requestId);
    const v = validateIoPatch(parsed.body, current);
    if (!v.valid) return validationError(requestId, v.fields);
    if (current.status === "signed") {
      return conflict(requestId, "insertion_order_signed", `${formatIoNumber(current.seq)} is signed and can no longer change`);
    }
    const now = nowIso();
    let io = current;
    if (v.value.editsFields) {
      const updated = await db.paperwork.updateInsertionOrder(orgId, dealId, v.value, now);
      if (!updated) return conflict(requestId, "insertion_order_signed", `${formatIoNumber(current.seq)} is signed and can no longer change`);
      io = updated;
      await audit(db, actor, requestId, orgId, now, {
        type: "deal.io.updated",
        kind: "insertion_order",
        subjectId: io.id,
        subjectName: formatIoNumber(io.seq),
        description: `Updated ${formatIoNumber(io.seq)} (${formatMoney(io.totalCents, io.currency)})`,
        payload: { insertionOrderId: insertionOrderPublicId(io.id), totalCents: io.totalCents, currency: io.currency, paymentDueOn: io.paymentDueOn },
      });
    }
    if (v.value.sign) {
      const signed = await db.paperwork.signInsertionOrder(orgId, dealId, now);
      if (!signed) return conflict(requestId, "insertion_order_signed", `${formatIoNumber(current.seq)} is already signed`);
      io = signed;
      await audit(db, actor, requestId, orgId, now, {
        type: "deal.io.signed",
        kind: "insertion_order",
        subjectId: io.id,
        subjectName: formatIoNumber(io.seq),
        description: `Recorded ${formatIoNumber(io.seq)} as signed`,
        payload: { insertionOrderId: insertionOrderPublicId(io.id), dealId: dealPublicId(dealId) },
      });
    }
    return successResponse({ insertionOrder: toPublicInsertionOrder(io) }, requestId);
  });
}

/**
 * POST deals/{rbd}/insertion-order/send — email the IO to the sponsor contact
 * through notifications-worker. 202 means ACCEPTED by the notifications
 * worker, not delivered (runbook trap 27). Each send has its own idempotency
 * key (`deal.io.sent:<rbo>:<n>`), so a retried request collapses to one email
 * and a deliberate re-send is a new one.
 */
export async function handleSendInsertionOrder(env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const io = await db.paperwork.getInsertionOrder(orgId, dealId);
    if (!io) return notFound(requestId);
    if (io.status === "signed") return conflict(requestId, "insertion_order_signed", `${formatIoNumber(io.seq)} is already signed`);
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    const sponsor = await db.deals.getSponsor(orgId, deal.sponsorId);
    if (!sponsor?.contactEmail) {
      return conflict(requestId, "no_contact_email", `Add a contact email to ${deal.sponsorName} before sending the insertion order`);
    }
    const bookings = (await db.deals.listBookingsForDeal(orgId, dealId)).filter((b) => b.releasedAt === null);
    const number = formatIoNumber(io.seq);
    const ioId = insertionOrderPublicId(io.id);
    const sendNo = io.sendCount + 1;
    const sent = await enqueueEmail(
      env,
      { requestId, actorSubjectType: actor.subjectType, actorSubjectId: actor.subjectId },
      {
        orgId,
        category: "product",
        templateKey: DEAL_IO_TEMPLATE_KEY,
        templateData: {
          ioNumber: number,
          dealTitle: deal.title,
          sponsorName: deal.sponsorName,
          contactName: sponsor.contactName,
          total: formatMoney(io.totalCents, io.currency),
          paymentDueOn: io.paymentDueOn,
          terms: io.terms.slice(0, 4000),
          placements: bookings
            .map((b) => `${b.publishOn} · ${b.publicationName} · ${b.issueTitle} · ${SLOT_FORMAT_LABELS[b.format as SlotFormat] ?? b.format} (${b.slotLabel})`)
            .join("\n")
            .slice(0, 4000),
        },
        recipient: { channel: "email", address: sponsor.contactEmail },
        idempotencyKey: `${DEAL_IO_TEMPLATE_KEY}:${ioId}:${sendNo}`,
        correlationId: ioId,
      },
    );
    if (!sent.ok) {
      return errorResponse("internal_error", "The email service did not accept the insertion order; nothing was sent", 503, requestId, { reason: sent.reason });
    }
    const now = nowIso();
    const marked = await db.paperwork.markInsertionOrderSent({
      orgId, dealId, expectedSendCount: io.sendCount, sentTo: sponsor.contactEmail, notificationId: sent.notificationId, now,
    });
    const latest = marked ?? (await db.paperwork.getInsertionOrder(orgId, dealId)) ?? io;
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.io.sent",
      kind: "insertion_order",
      subjectId: io.id,
      subjectName: number,
      description: `Sent ${number} for "${deal.title}" to ${deal.sponsorName}`,
      // Never the contact's address (design §5).
      payload: { insertionOrderId: ioId, dealId: dealPublicId(dealId), number, send: sendNo, notificationId: sent.notificationId },
    });
    return successResponse(
      { insertionOrder: toPublicInsertionOrder(latest), notification: { id: sent.notificationId, status: "accepted" } },
      requestId,
      202,
    );
  });
}

// ── deliveries ─────────────────────────────────────────────

/** PUT deals/{rbd}/bookings/{rbb}/delivery — create or replace one booking's proof of delivery. */
export async function handlePutDelivery(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string, bookingId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateDeliveryBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    const booking = await db.deals.getBooking(orgId, bookingId);
    if (!booking || booking.dealId !== dealId) return notFound(requestId);
    if (booking.releasedAt !== null) return conflict(requestId, "already_released", "That booking was released; there is nothing to deliver");
    const now = nowIso();
    const delivery = await db.paperwork.upsertDelivery({
      id: crypto.randomUUID(), orgId, dealId, bookingId, ...v.value, recordedBy: actorSubjectUuid(actor.subjectId), now,
    });
    if (!delivery) {
      const latest = await db.deals.getDeal(orgId, dealId);
      if (!latest) return notFound(requestId);
      if (!ISSUABLE.has(latest.stage)) {
        return conflict(requestId, "deal_not_booked", `Record deliveries once the deal is booked (it is ${latest.stage})`, { currentStage: latest.stage });
      }
      return conflict(requestId, "already_released", "That booking was released; there is nothing to deliver");
    }
    const outstanding = await db.paperwork.countUndeliveredBookings(orgId, dealId);
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.delivery.recorded",
      kind: "delivery",
      subjectId: delivery.id,
      subjectName: `${booking.issueTitle} — ${booking.slotLabel}`,
      description: `Recorded delivery of ${booking.slotLabel} in "${booking.issueTitle}" on ${delivery.deliveredOn}`,
      payload: {
        deliveryId: deliveryPublicId(delivery.id),
        bookingId: bookingPublicId(bookingId),
        dealId: dealPublicId(dealId),
        deliveredOn: delivery.deliveredOn,
        opens: delivery.opens,
        clicks: delivery.clicks,
        impressions: delivery.impressions,
        downloads: delivery.downloads,
      },
    });
    return successResponse({ delivery: toPublicDelivery(delivery), undeliveredBookings: outstanding }, requestId);
  });
}

// ── report links ───────────────────────────────────────────

/** POST deals/{rbd}/report-links — the token is in this response and nowhere else, ever. */
export async function handleCreateReportLink(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  const parsed = await readOptionalJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateReportLinkBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    const now = nowIso();
    const expiresAt =
      v.value.expiresInDays === null ? null : new Date(Date.parse(now) + v.value.expiresInDays * 86_400_000).toISOString();
    const token = newReportToken();
    const link = await db.paperwork.createReportLink({
      id: crypto.randomUUID(), orgId, dealId, tokenSha256: await sha256Hex(token), expiresAt, createdBy: actorSubjectUuid(actor.subjectId), now,
    });
    if (!link) {
      const live = (await db.paperwork.listReportLinks(orgId, dealId)).find((l) => l.revokedAt === null);
      return conflict(requestId, "report_link_exists", `"${deal.title}" already has a live report link; revoke it first`, {
        reportLinkId: live ? reportLinkPublicId(live.id) : null,
      });
    }
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.report_link.created",
      kind: "report_link",
      subjectId: link.id,
      subjectName: deal.title,
      description: `Created a sponsor report link for "${deal.title}"${expiresAt ? ` (expires ${expiresAt.slice(0, 10)})` : ""}`,
      payload: { reportLinkId: reportLinkPublicId(link.id), dealId: dealPublicId(dealId), expiresAt },
    });
    return successResponse(
      { reportLink: toPublicReportLink(link, now), token, path: `/ingress/rateboard/r/${token}` },
      requestId,
      201,
    );
  });
}

/** DELETE deals/{rbd}/report-links/{rbr} — revoke; the link answers 404 from now on. */
export async function handleRevokeReportLink(env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string, linkId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const now = nowIso();
    const link = await db.paperwork.revokeReportLink({ orgId, dealId, id: linkId, revokedBy: actorSubjectUuid(actor.subjectId), now });
    if (!link) {
      const existing = await db.paperwork.getReportLink(orgId, dealId, linkId);
      if (!existing) return notFound(requestId);
      return conflict(requestId, "already_revoked", "That link is already revoked");
    }
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.report_link.revoked",
      kind: "report_link",
      subjectId: link.id,
      subjectName: dealPublicId(dealId),
      description: "Revoked a sponsor report link",
      payload: { reportLinkId: reportLinkPublicId(link.id), dealId: dealPublicId(dealId) },
    });
    return successResponse({ reportLink: toPublicReportLink(link, now) }, requestId);
  });
}

async function readOptionalJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const raw = await request.text();
  if (raw.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
