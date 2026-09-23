import { createDealRepository } from "@saas/db/deal";
import { createSqlExecutor } from "@saas/db/d1";
import { OWNER, VIEWER, d1Over, json, world } from "./harness";
import { ORG, auditTypes, book, call, get, move, newDeal, ok, seed, send } from "./fixtures";

// Design §2: a slot holds at most one live booking. These tests prove it is a
// constraint of the database, not a check in the handler: the second claim is
// refused however it arrives — sequentially, concurrently, or by SQL that
// bypasses the worker entirely.

describe("the double-booking guarantee", () => {
  it("refuses a second booking of a booked slot with 409 slot_already_booked", async () => {
    const w = world();
    const { deal, primary, issue } = await seed(w);
    await ok(await book(w, deal.id, primary.id), 201);

    const rival = await newDeal(w, "Competing offer", "Globex");
    const refused = await book(w, rival.id, primary.id);
    expect(refused.status).toBe(409);
    const err = (await json(refused)).error;
    expect(err.code).toBe("conflict");
    expect(err.details.reason).toBe("slot_already_booked");
    expect(err.details.heldByDealId).toBe(deal.id);

    // The same deal booking the same slot twice is refused too.
    expect((await book(w, deal.id, primary.id)).status).toBe(409);

    // The calendar shows the slot held by the first deal, the other slot open.
    const inv = await ok(await get(w, `/v1/organizations/${ORG}/inventory?from=2026-10-01&to=2026-10-31`, VIEWER));
    expect(inv.issues).toHaveLength(1);
    expect(inv.issues[0].id).toBe(issue.id);
    const [p, s] = inv.issues[0].slots;
    expect(p.booking).toMatchObject({ dealId: deal.id, sponsorName: "Acme Analytics", dealStage: "lead", priceCents: 120_000 });
    expect(s.booking).toBeNull();

    // The refusal is on the audit trail: a creator can see a teammate tried.
    expect(auditTypes(w).filter((t) => t === "deal.booking.refused")).toHaveLength(2);
    const rivalDetail = await ok(await get(w, `/v1/organizations/${ORG}/deals/${rival.id}`, OWNER));
    expect(rivalDetail.bookings).toHaveLength(0);
  });

  it("under a race of concurrent claims on one slot, exactly one wins", async () => {
    const w = world();
    const { primary } = await seed(w);
    const deals = [];
    for (let i = 0; i < 12; i++) deals.push(await newDeal(w, `Bidder ${i}`, `Sponsor ${i}`));

    const results = await Promise.all(deals.map((d) => book(w, d.id, primary.id)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    const reasons = await Promise.all(results.filter((r) => r.status === 409).map(async (r) => (await json(r)).error.details.reason));
    expect(new Set(reasons)).toEqual(new Set(["slot_already_booked"]));

    const live = w.db.prepare("SELECT COUNT(*) AS n FROM deal_bookings WHERE released_at IS NULL").get() as { n: number };
    expect(live.n).toBe(1);
  });

  it("holds even when the application is bypassed: the partial unique index refuses raw SQL", async () => {
    const w = world();
    const { deal, primary } = await seed(w);
    const booked = await ok(await book(w, deal.id, primary.id), 201);
    const row = w.db.prepare("SELECT * FROM deal_bookings").get() as Record<string, unknown>;
    const insert = w.db.prepare(
      `INSERT INTO deal_bookings (id, org_id, deal_id, slot_id, price_cents, currency, format, niche, audience_size, booked_at)
       VALUES (?, ?, ?, ?, 1, 'USD', 'nl_primary', 'tech', 1, '2026-09-23T00:00:00Z')`,
    );
    expect(() => insert.run(crypto.randomUUID(), row.org_id as string, row.deal_id as string, row.slot_id as string)).toThrow(/UNIQUE/);

    // Released bookings are history, not holds: the index is partial.
    await ok(await send(w, `/v1/organizations/${ORG}/deals/${deal.id}/bookings/${booked.booking.id}`, OWNER, {}, "DELETE"));
    expect(() => insert.run(crypto.randomUUID(), row.org_id as string, row.deal_id as string, row.slot_id as string)).not.toThrow();
    expect(() => insert.run(crypto.randomUUID(), row.org_id as string, row.deal_id as string, row.slot_id as string)).toThrow(/UNIQUE/);
  });

  it("the repository claim reports a refusal as null, never a thrown error or a rowCount", async () => {
    const w = world();
    const { deal, primary } = await seed(w);
    const repo = createDealRepository(createSqlExecutor(d1Over(w.db)));
    const orgUuid = (w.db.prepare("SELECT org_id FROM deal_deals").get() as { org_id: string }).org_id;
    const dealUuid = (w.db.prepare("SELECT id FROM deal_deals").get() as { id: string }).id;
    const slotUuid = (w.db.prepare("SELECT id FROM deal_slots WHERE label = 'Primary'").get() as { id: string }).id;
    const input = { orgId: orgUuid, dealId: dealUuid, slotId: slotUuid, priceCents: null, bookedBy: null, now: "2026-09-23T10:00:00.000Z" };
    const first = await repo.claimBooking({ id: crypto.randomUUID(), ...input });
    expect(first).not.toBeNull();
    expect(await repo.claimBooking({ id: crypto.randomUUID(), ...input })).toBeNull();
    const why = await repo.claimContext(orgUuid, dealUuid, slotUuid);
    expect(why.liveBooking?.id).toBe(first);
    expect(deal.id).toContain(dealUuid.replace(/-/g, ""));
    expect(primary.id).toContain(slotUuid.replace(/-/g, ""));
  });

  it("enforces the release rules", async () => {
    const w = world();
    const { deal, primary, secondary } = await seed(w);
    const a = await ok(await book(w, deal.id, primary.id), 201);
    const b = await ok(await book(w, deal.id, secondary.id), 201);
    await ok(await move(w, deal.id, "pitched"));
    await ok(await move(w, deal.id, "booked"));

    // A booked deal keeps at least one slot; two concurrent releases of its
    // last two bookings cannot both succeed.
    const both = await Promise.all([
      send(w, `/v1/organizations/${ORG}/deals/${deal.id}/bookings/${a.booking.id}`, OWNER, {}, "DELETE"),
      send(w, `/v1/organizations/${ORG}/deals/${deal.id}/bookings/${b.booking.id}`, OWNER, {}, "DELETE"),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = both.find((r) => r.status === 409)!;
    expect((await json(refused)).error.details.reason).toBe("last_booking");

    // Releasing an already-released booking is a 409, not a silent 200.
    const released = both.find((r) => r.status === 200)!;
    const releasedId = (await json(released)).data.booking.id;
    const again = await send(w, `/v1/organizations/${ORG}/deals/${deal.id}/bookings/${releasedId}`, OWNER, {}, "DELETE");
    expect((await json(again)).error.details.reason).toBe("already_released");

    // A delivered deal takes no new bookings.
    await ok(await move(w, deal.id, "delivered"));
    const late = await book(w, deal.id, releasedId === a.booking.id ? primary.id : secondary.id);
    expect(late.status).toBe(409);
    expect((await json(late)).error.details.reason).toBe("deal_not_bookable");
  });

  it("validates slots, prices and formats", async () => {
    const w = world();
    const { deal, publication, issue } = await seed(w);
    const podcastFormat = await send(w, `/v1/organizations/${ORG}/issues/${issue.id}/slots`, OWNER, { label: "Mid", format: "pod_midroll" });
    expect(podcastFormat.status).toBe(422);

    const noPrice = await ok(await send(w, `/v1/organizations/${ORG}/issues/${issue.id}/slots`, OWNER, { label: "Classified", format: "nl_classified" }), 201);
    const unpriced = await book(w, deal.id, noPrice.slot.id);
    expect(unpriced.status).toBe(422);
    expect(Object.keys((await json(unpriced)).error.details.fields)).toEqual(["priceCents"]);
    const priced = await ok(await send(w, `/v1/organizations/${ORG}/deals/${deal.id}/bookings`, OWNER, { slotId: noPrice.slot.id, priceCents: 9_900 }), 201);
    expect(priced.booking.priceCents).toBe(9_900);

    const dupLabel = await send(w, `/v1/organizations/${ORG}/issues/${issue.id}/slots`, OWNER, { label: "primary", format: "nl_primary" });
    expect(dupLabel.status).toBe(409);
    const dupPub = await send(w, `/v1/organizations/${ORG}/publications`, OWNER, { name: "the stack weekly", kind: "podcast", niche: "tech", audienceSize: 1 });
    expect((await json(dupPub)).error.details.reason).toBe("duplicate_name");
    const dupIssue = await send(w, `/v1/organizations/${ORG}/publications/${publication.id}/issues`, OWNER, { title: "Issue #142", publishOn: "2026-10-13" });
    expect(dupIssue.status).toBe(409);

    const badRange = await get(w, `/v1/organizations/${ORG}/inventory?from=2026-10-01&to=2027-06-01`, OWNER);
    expect(badRange.status).toBe(422);
    const badDate = await get(w, `/v1/organizations/${ORG}/inventory?from=2026-02-30`, OWNER);
    expect(badDate.status).toBe(422);
    const unknownRoute = await call(w, `/v1/organizations/${ORG}/deals/${deal.id}/history`, { headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } });
    expect(unknownRoute.status).toBe(404);
  });
});
