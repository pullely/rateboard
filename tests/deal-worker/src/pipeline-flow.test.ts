/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { MEMBER, OWNER, VIEWER, json, world } from "./harness";
import { ORG, auditTypes, book, get, move, newDeal, ok, seed, send } from "./fixtures";

describe("the pipeline", () => {
  it("moves a deal lead → pitched → booked → delivered → paid, recording every move", async () => {
    const w = world();
    const { deal, primary } = await seed(w);
    expect(deal.id).toMatch(/^rbd_[0-9a-f]{32}$/);
    expect(deal.stage).toBe("lead");
    expect(deal.sponsorName).toBe("Acme Analytics");
    expect(deal.nextStages).toEqual(["pitched", "lost"]);

    expect((await ok(await move(w, deal.id, "pitched", MEMBER))).deal.stage).toBe("pitched");

    // booked needs a live booking, checked inside the conditional UPDATE
    const early = await move(w, deal.id, "booked");
    expect(early.status).toBe(409);
    expect((await json(early)).error.details.reason).toBe("no_bookings");

    const booked = await ok(await book(w, deal.id, primary.id), 201);
    expect(booked.booking.priceCents).toBe(120_000); // the slot's list price
    expect(booked.booking.format).toBe("nl_primary");
    expect(booked.booking.niche).toBe("tech");
    expect(booked.booking.audienceSize).toBe(24_000);
    expect(booked.deal.liveBookings).toBe(1);

    for (const to of ["booked", "delivered", "paid"]) {
      expect((await ok(await move(w, deal.id, to))).deal.stage).toBe(to);
    }
    const detail = await ok(await get(w, `/v1/organizations/${ORG}/deals/${deal.id}`, VIEWER));
    expect(detail.deal.nextStages).toEqual([]);
    expect(detail.history.map((h: any) => `${h.fromStage}->${h.toStage}`)).toEqual([
      "null->lead",
      "lead->pitched",
      "pitched->booked",
      "booked->delivered",
      "delivered->paid",
    ]);
    expect(detail.bookings).toHaveLength(1);

    const types = auditTypes(w);
    expect(types.filter((t) => t === "deal.stage.changed")).toHaveLength(4);
    expect(types).toEqual(expect.arrayContaining(["deal.publication.created", "deal.issue.created", "deal.sponsor.created", "deal.created", "deal.booking.created"]));
    const categories = w.db.prepare("SELECT DISTINCT category FROM events_audit_entries").all() as { category: string }[];
    expect(categories.map((c) => c.category)).toEqual(["deal"]);
  });

  it("refuses moves the state machine does not allow (422) and lost races (409 stage_conflict)", async () => {
    const w = world();
    const { deal } = await seed(w);
    const skip = await move(w, deal.id, "paid");
    expect(skip.status).toBe(422);

    // The caller believes the deal is pitched; it is still a lead.
    const stale = await move(w, deal.id, "booked", OWNER, "pitched");
    expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body.error.details.reason).toBe("stage_conflict");
    expect(body.error.details.currentStage).toBe("lead");

    // Two concurrent moves of the same deal: exactly one wins.
    const results = await Promise.all([move(w, deal.id, "pitched", OWNER, "lead"), move(w, deal.id, "lost", MEMBER, "lead")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const history = w.db.prepare("SELECT COUNT(*) AS n FROM deal_stage_history").get() as { n: number };
    expect(history.n).toBe(2); // creation + the one move that won
  });

  it("losing a deal releases its slots, and a lost deal can be reopened", async () => {
    const w = world();
    const { deal, primary, secondary } = await seed(w);
    await ok(await book(w, deal.id, primary.id), 201);
    await ok(await book(w, deal.id, secondary.id), 201);
    await ok(await move(w, deal.id, "pitched"));
    const lost = await ok(await move(w, deal.id, "lost"));
    expect(lost.deal.liveBookings).toBe(0);

    const other = await newDeal(w, "Rebound");
    await ok(await book(w, other.id, primary.id), 201); // the slot is free again

    const detail = await ok(await get(w, `/v1/organizations/${ORG}/deals/${deal.id}`, OWNER));
    expect(detail.bookings.every((b: any) => b.releaseReason === "deal_lost")).toBe(true);
    expect((await ok(await move(w, deal.id, "lead"))).deal.stage).toBe("lead");
  });

  it("summarises the pipeline per stage with values per currency", async () => {
    const w = world();
    await seed(w);
    await ok(await send(w, `/v1/organizations/${ORG}/deals`, OWNER, { sponsorName: "Initech", title: "Podcast pilot", valueCents: 50_000, currency: "EUR" }), 201);
    const { stages } = await ok(await get(w, `/v1/organizations/${ORG}/pipeline`, VIEWER));
    expect(stages.map((s: any) => s.stage)).toEqual(["lead", "pitched", "booked", "delivered", "paid", "lost"]);
    expect(stages[0]).toEqual({ stage: "lead", count: 2, valueByCurrency: { USD: 120_000, EUR: 50_000 } });
    expect(stages[1]).toEqual({ stage: "pitched", count: 0, valueByCurrency: {} });
  });

  it("creates deals against an existing sponsor or a new one by name (matched case-insensitively)", async () => {
    const w = world();
    const { deal } = await seed(w);
    const again = await newDeal(w, "Q1 renewal", "acme analytics");
    expect(again.sponsorId).toBe(deal.sponsorId);
    const { sponsors } = await ok(await get(w, `/v1/organizations/${ORG}/sponsors`, OWNER));
    expect(sponsors).toHaveLength(1);
    const byId = await ok(await send(w, `/v1/organizations/${ORG}/deals`, OWNER, { sponsorId: deal.sponsorId, title: "Bonus" }), 201);
    expect(byId.deal.sponsorName).toBe("Acme Analytics");
    const sponsor = await ok(await get(w, `/v1/organizations/${ORG}/sponsors/${deal.sponsorId}`, VIEWER));
    expect(sponsor.deals).toHaveLength(3);

    const cpmNoRate = await send(w, `/v1/organizations/${ORG}/deals`, OWNER, { sponsorName: "X", title: "Y", pricing: "cpm" });
    expect(cpmNoRate.status).toBe(422);
    expect(Object.keys((await json(cpmNoRate)).error.details.fields)).toEqual(["cpmCents"]);

    const patchStage = await send(w, `/v1/organizations/${ORG}/deals/${deal.id}`, OWNER, { stage: "paid" }, "PATCH");
    expect(patchStage.status).toBe(422);
    const patched = await ok(await send(w, `/v1/organizations/${ORG}/deals/${deal.id}`, MEMBER, { notes: "Wants a mid-October date" }, "PATCH"));
    expect(patched.deal.notes).toBe("Wants a mid-October date");
    expect(patched.deal.title).toBe("Q4 launch");
  });
});
