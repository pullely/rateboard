import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { notFound, successResponse, validationError } from "../http.js";
import { actorSubjectUuid, bookingPublicId, dealPublicId, parseSlotPublicId, slotPublicId } from "../ids.js";
import { toPublicBooking, toPublicDeal } from "../present.js";
import { validateBookingBody } from "../validate.js";
import { audit, conflict, formatMoney, invalidJson, readJson, withDb } from "./common.js";

/**
 * POST deals/{rbd}/bookings — claim a slot for a deal (design §2).
 *
 * The claim is ONE statement (`DealRepository.claimBooking`): the partial
 * unique index on live bookings refuses a second claim on the slot, however
 * many arrive at once. Nothing here reads "is it free?" before writing; the
 * reads after a refusal only name the reason for the 409.
 */
export async function handleCreateBooking(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const v = validateBookingBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const slotId = parseSlotPublicId(v.value.slotId);
    if (!slotId) return validationError(requestId, { slotId: ["Not a slot id"] });
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    const slot = await db.deals.getSlot(orgId, slotId);
    if (!slot) return validationError(requestId, { slotId: ["No such slot in this organization"] });
    if (v.value.priceCents === null && slot.listPriceCents === null) {
      return validationError(requestId, { priceCents: ["Required: the slot has no list price"] });
    }

    const now = nowIso();
    const id = crypto.randomUUID();
    const claimed = await db.deals.claimBooking({
      id, orgId, dealId, slotId, priceCents: v.value.priceCents, bookedBy: actorSubjectUuid(actor.subjectId), now,
    });

    if (!claimed) {
      const why = await db.deals.claimContext(orgId, dealId, slotId);
      if (why.dealStage === null || !why.slotExists) return notFound(requestId);
      if (why.liveBooking) {
        await audit(db, actor, requestId, orgId, now, {
          type: "deal.booking.refused",
          kind: "slot",
          subjectId: slotId,
          subjectName: slot.label,
          description: `Refused a second booking of "${slot.label}" for "${deal.title}": the slot is already booked`,
          payload: {
            slotId: slotPublicId(slotId),
            dealId: dealPublicId(dealId),
            heldByDealId: dealPublicId(why.liveBooking.dealId),
            reason: "slot_already_booked",
          },
        });
        return conflict(requestId, "slot_already_booked", "That slot is already booked", {
          slotId: slotPublicId(slotId),
          bookingId: bookingPublicId(why.liveBooking.id),
          heldByDealId: dealPublicId(why.liveBooking.dealId),
        });
      }
      if (why.issueStatus === "cancelled") return conflict(requestId, "issue_cancelled", "That issue is cancelled");
      if (!["lead", "pitched", "booked"].includes(why.dealStage)) {
        return conflict(requestId, "deal_not_bookable", `A ${why.dealStage} deal cannot take new bookings`, { currentStage: why.dealStage });
      }
      // The slot was freed between the claim and this read: say so rather than guess.
      return conflict(requestId, "slot_already_booked", "That slot was being booked at the same moment; try again");
    }

    const booking = await db.deals.getBooking(orgId, claimed);
    const fresh = await db.deals.getDeal(orgId, dealId);
    if (!booking || !fresh) throw new Error("booking: claimed row not readable");
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.booking.created",
      kind: "booking",
      subjectId: booking.id,
      subjectName: `${booking.issueTitle} — ${booking.slotLabel}`,
      description: `Booked "${booking.slotLabel}" in ${booking.publicationName} "${booking.issueTitle}" (${booking.publishOn}) for "${fresh.title}" at ${formatMoney(booking.priceCents, booking.currency)}`,
      payload: {
        bookingId: bookingPublicId(booking.id),
        dealId: dealPublicId(dealId),
        slotId: slotPublicId(slotId),
        priceCents: booking.priceCents,
        currency: booking.currency,
        format: booking.format,
      },
    });
    return successResponse({ booking: toPublicBooking(booking), deal: toPublicDeal(fresh) }, requestId, 201);
  });
}

/** DELETE deals/{rbd}/bookings/{rbb} — release a booking (design §2). */
export async function handleReleaseBooking(env: Env, requestId: string, actor: ActorContext, orgId: string, dealId: string, bookingId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "deal.write", async (db) => {
    const current = await db.deals.getBooking(orgId, bookingId);
    if (!current || current.dealId !== dealId) return notFound(requestId);
    if (current.releasedAt !== null) return conflict(requestId, "already_released", "That booking was already released");
    const now = nowIso();
    const released = await db.deals.releaseBooking({ orgId, dealId, bookingId, releasedBy: actorSubjectUuid(actor.subjectId), now });
    const deal = await db.deals.getDeal(orgId, dealId);
    if (!deal) return notFound(requestId);
    if (!released) {
      const again = await db.deals.getBooking(orgId, bookingId);
      if (again?.releasedAt) return conflict(requestId, "already_released", "That booking was already released");
      if (deal.stage === "booked") {
        return conflict(requestId, "last_booking", "A booked deal keeps at least one slot; move it to lost to release them all");
      }
      return conflict(requestId, "deal_not_bookable", `A ${deal.stage} deal's bookings are part of its record`, { currentStage: deal.stage });
    }
    await audit(db, actor, requestId, orgId, now, {
      type: "deal.booking.released",
      kind: "booking",
      subjectId: released.id,
      subjectName: `${released.issueTitle} — ${released.slotLabel}`,
      description: `Released "${released.slotLabel}" in "${released.issueTitle}" from "${deal.title}"`,
      payload: { bookingId: bookingPublicId(released.id), dealId: dealPublicId(dealId), slotId: slotPublicId(released.slotId) },
    });
    return successResponse({ booking: toPublicBooking(released), deal: toPublicDeal(deal) }, requestId);
  });
}
