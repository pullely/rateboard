/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { createDealRepository } from "@saas/db/deal";
import { createSqlExecutor } from "@saas/db/d1";
import { ORG_A, ORG_B, OTHER_OWNER, OWNER, STRANGER, VIEWER, d1Over, json, migratedDatabase, world } from "./harness";
import { ORG, OTHER_ORG, book, call, get, ok, seed, send } from "./fixtures";

describe("the tenant boundary", () => {
  it("answers 404 to a signed-in non-member on every route, and 401 without an actor", async () => {
    const w = world();
    const { deal, publication, issue, primary, secondary } = await seed(w);
    const paths: [string, string, unknown?][] = [
      ["GET", `/v1/organizations/${ORG}/publications`],
      ["POST", `/v1/organizations/${ORG}/publications`, { name: "X", kind: "podcast", niche: "tech", audienceSize: 1 }],
      ["GET", `/v1/organizations/${ORG}/publications/${publication.id}`],
      ["POST", `/v1/organizations/${ORG}/publications/${publication.id}/issues`, { title: "T", publishOn: "2026-11-01" }],
      ["POST", `/v1/organizations/${ORG}/issues/${issue.id}/slots`, { label: "L", format: "nl_classified" }],
      ["GET", `/v1/organizations/${ORG}/inventory`],
      ["GET", `/v1/organizations/${ORG}/sponsors`],
      ["GET", `/v1/organizations/${ORG}/sponsors/${deal.sponsorId}`],
      ["GET", `/v1/organizations/${ORG}/deals`],
      ["GET", `/v1/organizations/${ORG}/deals/${deal.id}`],
      ["POST", `/v1/organizations/${ORG}/deals/${deal.id}/stage`, { to: "pitched" }],
      ["POST", `/v1/organizations/${ORG}/deals/${deal.id}/bookings`, { slotId: secondary.id }],
      ["GET", `/v1/organizations/${ORG}/pipeline`],
    ];
    for (const who of [STRANGER, OTHER_OWNER]) {
      for (const [method, path, body] of paths) {
        const res = await call(w, path, {
          method,
          headers: { "x-actor-subject-id": who, "x-actor-subject-type": "user", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
    }
    expect((await call(w, `/v1/organizations/${ORG}/deals`)).status).toBe(401);
    // Nothing a non-member sent was written.
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM deal_bookings").get() as { n: number }).n).toBe(0);
    expect(primary.booking).toBeNull();
  });

  it("a viewer reads but cannot write", async () => {
    const w = world();
    const { deal, secondary } = await seed(w);
    await ok(await get(w, `/v1/organizations/${ORG}/deals/${deal.id}`, VIEWER));
    await ok(await get(w, `/v1/organizations/${ORG}/inventory?from=2026-10-01`, VIEWER));
    expect((await book(w, deal.id, secondary.id, VIEWER)).status).toBe(404);
    expect((await send(w, `/v1/organizations/${ORG}/sponsors`, VIEWER, { name: "Nope" })).status).toBe(404);
  });

  it("another org's owner cannot reach this org's rows through their own org", async () => {
    const w = world();
    const mine = await seed(w);
    const theirs = await seed(w, { org: OTHER_ORG, who: OTHER_OWNER });
    // Their deal, my slot: the slot is not in their org.
    const cross = await book(w, theirs.deal.id, mine.primary.id, OTHER_OWNER, OTHER_ORG);
    expect(cross.status).toBe(422);
    expect((await json(cross)).error.details.fields.slotId).toEqual(["No such slot in this organization"]);
    // My deal id under their org path.
    expect((await get(w, `/v1/organizations/${OTHER_ORG}/deals/${mine.deal.id}`, OTHER_OWNER)).status).toBe(404);
    // Their calendar shows only their issue.
    const inv = await ok(await get(w, `/v1/organizations/${OTHER_ORG}/inventory?from=2026-10-01`, OTHER_OWNER));
    expect(inv.issues.map((i: any) => i.id)).toEqual([theirs.issue.id]);
    // Same publication name in two orgs is fine: uniqueness is per org.
    expect(theirs.publication.name).toBe(mine.publication.name);
    expect(OWNER).not.toBe(OTHER_OWNER);
  });
});

// Runbook trap 22: the D1 executor reports rowCount = rows.length, so a write
// without RETURNING always reports 0 on D1, whatever it changed. These run the
// real executor over a real SQLite engine — the combination a mocked executor
// hides — and pin that the deal repository decides "did my write happen?" from
// RETURNING rows, never from rowCount.
describe("trap 22: rowCount after a write on D1", () => {
  const NOW = "2026-09-23T10:00:00.000Z";

  async function fixture() {
    const executor = createSqlExecutor(d1Over(migratedDatabase()));
    const repo = createDealRepository(executor);
    const sponsor = await repo.createSponsor({
      id: crypto.randomUUID(), orgId: ORG_A, name: "Acme", website: null, contactName: null, contactEmail: null, notes: "", createdBy: null, now: NOW,
    });
    const deal = await repo.createDeal({
      id: crypto.randomUUID(), orgId: ORG_A, sponsorId: sponsor!.id, title: "D", valueCents: null, currency: "USD",
      pricing: "flat", cpmCents: null, notes: "", createdBy: null, now: NOW,
    });
    return { executor, repo, deal };
  }

  it("is 0 for an UPDATE without RETURNING even though the row changed", async () => {
    const { executor, repo, deal } = await fixture();
    const bare = await executor.execute(`UPDATE deal_deals SET title = $2 WHERE id = $1`, [deal.id, "Renamed"]);
    expect(bare.rowCount).toBe(0); // the trap: the row DID change
    expect((await repo.getDeal(ORG_A, deal.id))?.title).toBe("Renamed");
    const returning = await executor.execute(`UPDATE deal_deals SET title = $2 WHERE id = $1 RETURNING id`, [deal.id, "D"]);
    expect(returning.rowCount).toBe(1);
  });

  it("stage moves, updates and releases report their outcome through RETURNING, scoped by org", async () => {
    const { repo, deal } = await fixture();
    const move = { dealId: deal.id, from: "lead", to: "pitched", now: NOW, requireLiveBooking: false };
    expect(await repo.moveStage({ orgId: ORG_B, ...move })).toBeNull(); // another org: nothing changed
    expect((await repo.moveStage({ orgId: ORG_A, ...move }))?.stage).toBe("pitched");
    expect(await repo.moveStage({ orgId: ORG_A, ...move })).toBeNull(); // no longer at `from`
    expect(await repo.moveStage({ orgId: ORG_A, ...move, from: "pitched", to: "booked", requireLiveBooking: true })).toBeNull();

    const fields = { title: "D2", valueCents: 5, currency: "USD", pricing: "flat", cpmCents: null, notes: "" };
    expect(await repo.updateDeal(ORG_B, deal.id, fields, NOW)).toBeNull();
    expect((await repo.updateDeal(ORG_A, deal.id, fields, NOW))?.title).toBe("D2");
    expect(await repo.releaseAllForDeal({ orgId: ORG_A, dealId: deal.id, releasedBy: null, now: NOW })).toEqual([]);
  });

  it("a duplicate name is reported as null through ON CONFLICT DO NOTHING / OR IGNORE, not a throw", async () => {
    const { repo } = await fixture();
    const base = { orgId: ORG_A, website: null, contactName: null, contactEmail: null, notes: "", createdBy: null, now: NOW };
    expect(await repo.createSponsor({ id: crypto.randomUUID(), name: "ACME", ...base })).toBeNull();
    const other = await repo.createSponsor({ id: crypto.randomUUID(), name: "Globex", ...base });
    expect(await repo.updateSponsor(ORG_A, other!.id, { name: "acme", website: null, contactName: null, contactEmail: null, notes: "" }, NOW)).toBeNull();
    expect((await repo.getSponsor(ORG_A, other!.id))?.name).toBe("Globex");
  });
});
