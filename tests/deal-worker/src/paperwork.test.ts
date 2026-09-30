/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { createHash } from "node:crypto";
import { MEMBER, OTHER_OWNER, OWNER, STRANGER, VIEWER, json, world, type TestWorld } from "./harness";
import { ORG, OTHER_ORG, auditTypes, book, call, get, move, newDeal, ok, seed, send } from "./fixtures";

// RB2 (design §1.8, §3, §4.2): insertion orders numbered per org, proof of
// delivery gating `delivered`, and the no-login sponsor report link.

const D = (dealId: string, org = ORG) => `/v1/organizations/${org}/deals/${dealId}`;

/** A deal with both slots of one issue booked and moved to `booked`, the sponsor with a contact email. */
async function bookedDeal(w: TestWorld, opts: { org?: string; who?: string } = {}): Promise<{ deal: any; bookings: any[]; issue: any }> {
  const org = opts.org ?? ORG;
  const who = opts.who ?? OWNER;
  // Per world, per org: the first booked deal gets the plain names, later ones a suffix.
  const pubCounter = (w.db.prepare("SELECT COUNT(*) AS n FROM deal_publications").get() as { n: number }).n + 1;
  const s = await seed(w, { org, who, publicationName: pubCounter === 1 ? "The Stack Weekly" : `The Stack Weekly ${pubCounter}`, sponsorName: `Acme Analytics${pubCounter === 1 ? "" : ` ${pubCounter}`}` });
  const b1 = (await ok(await send(w, `${D(s.deal.id, org)}/bookings`, who, { slotId: s.primary.id }), 201)).booking;
  const b2 = (await ok(await send(w, `${D(s.deal.id, org)}/bookings`, who, { slotId: s.secondary.id }), 201)).booking;
  await ok(await send(w, `${D(s.deal.id, org)}/stage`, who, { to: "pitched" }));
  await ok(await send(w, `${D(s.deal.id, org)}/stage`, who, { to: "booked" }));
  const sponsorId = s.deal.sponsorId;
  await ok(await send(w, `/v1/organizations/${org}/sponsors/${sponsorId}`, who, { contactName: "Dana", contactEmail: "dana@acme.example" }, "PATCH"));
  return { deal: s.deal, bookings: [b1, b2], issue: s.issue };
}

function reportPath(token: string): string {
  return `/ingress/rateboard/r/${token}`;
}

/** The public lane exactly as api-edge forwards it: GET, no actor headers at all. */
function publicGet(w: TestWorld, token: string): Promise<Response> {
  return call(w, reportPath(token));
}

async function notFoundShape(res: Response): Promise<unknown> {
  const body = await json(res);
  delete body.error?.requestId;
  return { status: res.status, body };
}

describe("RB2 insertion orders", () => {
  it("is refused before the deal is booked, then numbered IO-0001 with the live bookings' total", async () => {
    const w = world();
    const s = await seed(w);
    await ok(await book(w, s.deal.id, s.primary.id), 201);
    const early = await send(w, `${D(s.deal.id)}/insertion-order`, OWNER, {});
    expect(early.status).toBe(409);
    expect((await json(early)).error.details.reason).toBe("deal_not_booked");

    await ok(await move(w, s.deal.id, "pitched"));
    await ok(await move(w, s.deal.id, "booked"));
    const { insertionOrder: io } = await ok(await send(w, `${D(s.deal.id)}/insertion-order`, OWNER, { terms: "Net 30", paymentDueOn: "2026-11-15" }), 201);
    expect(io).toMatchObject({ number: "IO-0001", status: "draft", totalCents: 120_000, currency: "USD", terms: "Net 30", paymentDueOn: "2026-11-15" });
    expect(io.id).toMatch(/^rbo_[0-9a-f]{32}$/);

    const again = await send(w, `${D(s.deal.id)}/insertion-order`, OWNER, {});
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.reason).toBe("insertion_order_exists");

    const read = await ok(await get(w, `${D(s.deal.id)}/insertion-order`, VIEWER));
    expect(read.insertionOrder.number).toBe("IO-0001");
    const detail = await ok(await get(w, D(s.deal.id), VIEWER));
    expect(detail.insertionOrder.number).toBe("IO-0001");
    expect(auditTypes(w)).toContain("deal.io.created");
  });

  it("numbers IOs uniquely per org under a concurrent burst, and each org starts at IO-0001", async () => {
    const w = world();
    const s = await seed(w);
    // Ten booked deals, one slot each, in fresh issues of the same publication.
    const deals: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { issue } = await ok(
        await send(w, `/v1/organizations/${ORG}/publications/${s.publication.id}/issues`, OWNER, {
          title: `Burst ${i}`, publishOn: "2026-10-20", slots: [{ label: "Primary", format: "nl_primary", listPriceCents: 10_000 + i }],
        }),
        201,
      );
      const deal = await newDeal(w, `Burst deal ${i}`, `Burst sponsor ${i}`);
      await ok(await book(w, deal.id, issue.slots[0].id), 201);
      await ok(await move(w, deal.id, "pitched"));
      await ok(await move(w, deal.id, "booked"));
      deals.push(deal.id);
    }
    const results = await Promise.all(deals.map((id) => send(w, `${D(id)}/insertion-order`, OWNER, {})));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const numbers = await Promise.all(results.map(async (r) => (await json(r)).data.insertionOrder.number as string));
    expect(new Set(numbers).size).toBe(10);
    expect([...numbers].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `IO-${String(i + 1).padStart(4, "0")}`));

    // A second org's sequence is its own.
    const other = await bookedDeal(w, { org: OTHER_ORG, who: OTHER_OWNER });
    const { insertionOrder } = await ok(await send(w, `${D(other.deal.id, OTHER_ORG)}/insertion-order`, OTHER_OWNER, {}), 201);
    expect(insertionOrder.number).toBe("IO-0001");
  });

  it("the database refuses a duplicate number even when the handler is bypassed", async () => {
    const w = world();
    const a = await bookedDeal(w);
    await ok(await send(w, `${D(a.deal.id)}/insertion-order`, OWNER, {}), 201);
    const row = w.db.prepare("SELECT org_id, deal_id, seq FROM deal_insertion_orders").get() as any;
    expect(() =>
      w.db
        .prepare("INSERT INTO deal_insertion_orders (id, org_id, deal_id, seq, total_cents, currency) VALUES ('x', ?, ?, ?, 0, 'USD')")
        .run(row.org_id, row.deal_id, row.seq),
    ).toThrow(/UNIQUE/);
  });

  it("sends through notifications as deal-worker (202 accepted), re-sends with a new key, and refuses without a contact", async () => {
    const w = world();
    const { deal } = await bookedDeal(w);
    const { insertionOrder: io } = await ok(await send(w, `${D(deal.id)}/insertion-order`, OWNER, { paymentDueOn: "2026-11-15" }), 201);

    const sent = await ok(await send(w, `${D(deal.id)}/insertion-order/send`, OWNER, {}), 202);
    expect(sent.notification).toEqual({ id: expect.stringMatching(/^ntf_/), status: "accepted" });
    expect(sent.insertionOrder).toMatchObject({ status: "sent", sendCount: 1, sentTo: "dana@acme.example" });
    expect(w.emails).toHaveLength(1);
    const email = w.emails[0]!;
    expect(email.headers["x-internal-actor"]).toBe("deal-worker");
    expect(email.body).toMatchObject({
      category: "product",
      templateKey: "deal.io.sent",
      recipient: { channel: "email", address: "dana@acme.example" },
      idempotencyKey: `deal.io.sent:${io.id}:1`,
      correlationId: io.id,
    });
    expect(email.body.templateData).toMatchObject({ ioNumber: "IO-0001", dealTitle: "Q4 launch", sponsorName: "Acme Analytics", total: "1650.00 USD", paymentDueOn: "2026-11-15" });
    expect(String(email.body.templateData.placements).split("\n")).toHaveLength(2);

    const resent = await ok(await send(w, `${D(deal.id)}/insertion-order/send`, OWNER, {}), 202);
    expect(resent.insertionOrder.sendCount).toBe(2);
    expect(w.emails[1]!.body.idempotencyKey).toBe(`deal.io.sent:${io.id}:2`);
    // The audit event never carries the contact's address (design §5).
    const payloads = w.db.prepare("SELECT payload FROM events_event_log WHERE type = 'deal.io.sent'").all() as { payload: string }[];
    expect(payloads).toHaveLength(2);
    for (const p of payloads) expect(p.payload).not.toContain("dana@acme.example");

    // Notifications down: 503, nothing recorded as sent.
    w.notificationsDown = true;
    const down = await send(w, `${D(deal.id)}/insertion-order/send`, OWNER, {});
    expect(down.status).toBe(503);
    w.notificationsDown = false;
    expect((await ok(await get(w, `${D(deal.id)}/insertion-order`, OWNER))).insertionOrder.sendCount).toBe(2);

    // No contact email: 409, and nothing is posted.
    const bare = await bookedDeal(w);
    await ok(await send(w, `/v1/organizations/${ORG}/sponsors/${bare.deal.sponsorId}`, OWNER, { contactEmail: null }, "PATCH"));
    await ok(await send(w, `${D(bare.deal.id)}/insertion-order`, OWNER, {}), 201);
    const refused = await send(w, `${D(bare.deal.id)}/insertion-order/send`, OWNER, {});
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details.reason).toBe("no_contact_email");
    expect(w.emails).toHaveLength(2);
  });

  it("records the signature by hand, after which the IO is frozen", async () => {
    const w = world();
    const { deal } = await bookedDeal(w);
    await ok(await send(w, `${D(deal.id)}/insertion-order`, OWNER, {}), 201);
    const edited = await ok(await send(w, `${D(deal.id)}/insertion-order`, MEMBER, { totalCents: 150_000, terms: "Net 15" }, "PATCH"));
    expect(edited.insertionOrder).toMatchObject({ totalCents: 150_000, terms: "Net 15", status: "draft" });
    const bad = await send(w, `${D(deal.id)}/insertion-order`, OWNER, { status: "sent" }, "PATCH");
    expect(bad.status).toBe(422);
    const signed = await ok(await send(w, `${D(deal.id)}/insertion-order`, OWNER, { status: "signed" }, "PATCH"));
    expect(signed.insertionOrder.status).toBe("signed");
    expect(signed.insertionOrder.signedAt).not.toBeNull();
    for (const [path, body, method] of [
      [`${D(deal.id)}/insertion-order`, { terms: "changed" }, "PATCH"],
      [`${D(deal.id)}/insertion-order/send`, {}, "POST"],
    ] as const) {
      const r = await send(w, path, OWNER, body, method);
      expect(r.status).toBe(409);
      expect((await json(r)).error.details.reason).toBe("insertion_order_signed");
    }
    expect(auditTypes(w)).toEqual(expect.arrayContaining(["deal.io.updated", "deal.io.signed"]));
  });
});

describe("RB2 proof of delivery", () => {
  it("booked → delivered is refused until EVERY live booking has a delivery", async () => {
    const w = world();
    const { deal, bookings } = await bookedDeal(w);
    const none = await move(w, deal.id, "delivered");
    expect(none.status).toBe(409);
    expect((await json(none)).error.details).toMatchObject({ reason: "undelivered_bookings", undeliveredBookings: 2 });

    const first = await ok(
      await send(w, `${D(deal.id)}/bookings/${bookings[0].id}/delivery`, MEMBER, {
        deliveredOn: "2026-10-06", proofUrl: "https://stack.example/p/142", opens: 11_800, clicks: 412,
      }, "PUT"),
    );
    expect(first.undeliveredBookings).toBe(1);
    expect(first.delivery.id).toMatch(/^rbv_/);
    const one = await move(w, deal.id, "delivered");
    expect(one.status).toBe(409);
    expect((await json(one)).error.details).toMatchObject({ reason: "undelivered_bookings", undeliveredBookings: 1 });

    const second = await ok(await send(w, `${D(deal.id)}/bookings/${bookings[1].id}/delivery`, OWNER, { deliveredOn: "2026-10-06", opens: 11_800 }, "PUT"));
    expect(second.undeliveredBookings).toBe(0);
    const moved = await ok(await move(w, deal.id, "delivered"));
    expect(moved.deal.stage).toBe("delivered");

    // A second PUT replaces the delivery rather than adding one.
    await ok(await send(w, `${D(deal.id)}/bookings/${bookings[0].id}/delivery`, OWNER, { deliveredOn: "2026-10-07", opens: 12_000, clicks: 450 }, "PUT"));
    const rows = w.db.prepare("SELECT COUNT(*) AS n FROM deal_deliveries").get() as { n: number };
    expect(rows.n).toBe(2);
    const detail = await ok(await get(w, D(deal.id), VIEWER));
    const primary = detail.bookings.find((b: any) => b.id === bookings[0].id);
    expect(primary.delivery).toMatchObject({ deliveredOn: "2026-10-07", opens: 12_000, clicks: 450, proofUrl: null });
    expect(auditTypes(w).filter((t) => t === "deal.delivery.recorded")).toHaveLength(3);
  });

  it("the delivered rule is inside the UPDATE: a raw deal row with an undelivered booking cannot be moved", async () => {
    const w = world();
    const { deal, bookings } = await bookedDeal(w);
    await ok(await send(w, `${D(deal.id)}/bookings/${bookings[0].id}/delivery`, OWNER, { deliveredOn: "2026-10-06" }, "PUT"));
    // Both moves race; neither can pass the NOT EXISTS while booking 2 is undelivered.
    const results = await Promise.all([move(w, deal.id, "delivered"), move(w, deal.id, "delivered")]);
    expect(results.map((r) => r.status)).toEqual([409, 409]);
    const stage = w.db.prepare("SELECT stage FROM deal_deals").get() as { stage: string };
    expect(stage.stage).toBe("booked");
  });

  it("refuses a delivery before the deal is booked, on a released booking, or on another deal's booking", async () => {
    const w = world();
    const s = await seed(w);
    const b = (await ok(await book(w, s.deal.id, s.primary.id), 201)).booking;
    const early = await send(w, `${D(s.deal.id)}/bookings/${b.id}/delivery`, OWNER, { deliveredOn: "2026-10-06" }, "PUT");
    expect(early.status).toBe(409);
    expect((await json(early)).error.details.reason).toBe("deal_not_booked");

    const other = await newDeal(w, "Other");
    const wrongDeal = await send(w, `${D(other.id)}/bookings/${b.id}/delivery`, OWNER, { deliveredOn: "2026-10-06" }, "PUT");
    expect(wrongDeal.status).toBe(404);

    await ok(await call(w, `${D(s.deal.id)}/bookings/${b.id}`, { method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } }));
    const released = await send(w, `${D(s.deal.id)}/bookings/${b.id}/delivery`, OWNER, { deliveredOn: "2026-10-06" }, "PUT");
    expect(released.status).toBe(409);
    expect((await json(released)).error.details.reason).toBe("already_released");

    const invalid = await send(w, `${D(s.deal.id)}/bookings/${b.id}/delivery`, OWNER, { deliveredOn: "2026-02-30", opens: -1 }, "PUT");
    expect(invalid.status).toBe(422);
  });
});

describe("RB2 sponsor report link", () => {
  async function deliveredDeal(w: TestWorld): Promise<{ deal: any; bookings: any[] }> {
    const d = await bookedDeal(w);
    await ok(await send(w, `${D(d.deal.id)}/bookings/${d.bookings[0].id}/delivery`, OWNER, {
      deliveredOn: "2026-10-06", proofUrl: "https://stack.example/p/142", opens: 11_800, clicks: 412,
    }, "PUT"));
    return d;
  }

  it("serves the delivered slots with no session, and stores only the token's SHA-256", async () => {
    const w = world();
    const { deal } = await deliveredDeal(w);
    await ok(await send(w, `${D(deal.id)}`, OWNER, { notes: "internal: they pay slow" }, "PATCH"));
    const created = await ok(await send(w, `${D(deal.id)}/report-links`, OWNER, { expiresInDays: 30 }), 201);
    const token: string = created.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.path).toBe(reportPath(token));
    expect(created.reportLink).toMatchObject({ live: true, revokedAt: null, viewCount: 0 });
    expect(created.reportLink.id).toMatch(/^rbr_/);

    // Only the hash is at rest: no column of any row holds the token.
    const rows = w.db.prepare("SELECT * FROM deal_report_links").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
    const logged = w.db.prepare("SELECT payload FROM events_event_log").all() as { payload: string }[];
    expect(JSON.stringify(logged)).not.toContain(token);

    const res = await publicGet(w, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.data.report).toMatchObject({ sponsorName: "Acme Analytics", dealTitle: "Q4 launch" });
    // Only the delivered booking is on the report (the secondary has no delivery yet).
    expect(body.data.report.lines).toEqual([
      {
        publicationName: "The Stack Weekly", publicationKind: "newsletter", issueTitle: "Issue #142", publishOn: "2026-10-06",
        slotLabel: "Primary", format: "nl_primary", deliveredOn: "2026-10-06", proofUrl: "https://stack.example/p/142",
        opens: 11_800, clicks: 412, impressions: null, downloads: null,
      },
    ]);
    const text = JSON.stringify(body);
    for (const secret of ["priceCents", "120000", "valueCents", "notes", "they pay slow", "dana@acme.example", "rbd_", "rbb_", "org_", "IO-", OWNER]) {
      expect(text).not.toContain(secret);
    }
    const viewed = w.db.prepare("SELECT view_count, last_viewed_at FROM deal_report_links").get() as any;
    expect(viewed.view_count).toBe(1);
    expect(viewed.last_viewed_at).not.toBeNull();
  });

  it("answers the SAME 404 for unknown, malformed, revoked and expired tokens", async () => {
    const w = world();
    const { deal } = await deliveredDeal(w);
    const unknown = await notFoundShape(await publicGet(w, "A".repeat(43)));
    const malformed = await notFoundShape(await publicGet(w, "not-a-token"));
    expect(unknown).toEqual({ status: 404, body: { error: { code: "not_found", message: "Not found", details: {} } } });
    expect(malformed).toEqual(unknown);

    const created = await ok(await send(w, `${D(deal.id)}/report-links`, OWNER, {}), 201);
    expect((await publicGet(w, created.token)).status).toBe(200);
    // One live link per deal.
    const dup = await send(w, `${D(deal.id)}/report-links`, OWNER, {});
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.details).toMatchObject({ reason: "report_link_exists", reportLinkId: created.reportLink.id });

    const revoked = await ok(await call(w, `${D(deal.id)}/report-links/${created.reportLink.id}`, {
      method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" },
    }));
    expect(revoked.reportLink).toMatchObject({ live: false });
    expect(await notFoundShape(await publicGet(w, created.token))).toEqual(unknown);
    const again = await call(w, `${D(deal.id)}/report-links/${created.reportLink.id}`, {
      method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" },
    });
    expect((await json(again)).error.details.reason).toBe("already_revoked");

    // After revoking, a new link can be made; expire it and it 404s the same way.
    const fresh = await ok(await send(w, `${D(deal.id)}/report-links`, OWNER, { expiresInDays: 1 }), 201);
    expect((await publicGet(w, fresh.token)).status).toBe(200);
    w.db.prepare("UPDATE deal_report_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE revoked_at IS NULL").run();
    expect(await notFoundShape(await publicGet(w, fresh.token))).toEqual(unknown);
    expect(auditTypes(w)).toEqual(expect.arrayContaining(["deal.report_link.created", "deal.report_link.revoked"]));
  });

  it("the public lane ignores any actor headers and accepts only GET", async () => {
    const w = world();
    const { deal } = await deliveredDeal(w);
    const { token } = await ok(await send(w, `${D(deal.id)}/report-links`, OWNER, {}), 201);
    const post = await call(w, reportPath(token), { method: "POST" });
    expect(post.status).toBe(405);
    // A stranger's actor headers neither help nor hurt: the token alone decides.
    expect((await call(w, reportPath(token), { headers: { "x-actor-subject-id": STRANGER, "x-actor-subject-type": "user" } })).status).toBe(200);
  });
});

describe("RB2 PATCH issues/{rbi}", () => {
  it("retitles and reschedules; refuses to cancel an issue with live bookings; a cancelled issue cannot be booked", async () => {
    const w = world();
    const s = await seed(w);
    const I = `/v1/organizations/${ORG}/issues/${s.issue.id}`;
    const renamed = await ok(await send(w, I, MEMBER, { title: "Issue #142 (moved)", publishOn: "2026-10-08" }, "PATCH"));
    expect(renamed.issue).toMatchObject({ title: "Issue #142 (moved)", publishOn: "2026-10-08", status: "scheduled" });
    expect(renamed.issue.slots).toHaveLength(2);

    const b = (await ok(await book(w, s.deal.id, s.primary.id), 201)).booking;
    const refused = await send(w, I, OWNER, { status: "cancelled" }, "PATCH");
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details).toMatchObject({ reason: "issue_has_bookings", liveBookings: 1 });

    await ok(await call(w, `${D(s.deal.id)}/bookings/${b.id}`, { method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } }));
    const cancelled = await ok(await send(w, I, OWNER, { status: "cancelled" }, "PATCH"));
    expect(cancelled.issue.status).toBe("cancelled");
    const late = await book(w, s.deal.id, s.secondary.id);
    expect(late.status).toBe(409);
    expect((await json(late)).error.details.reason).toBe("issue_cancelled");

    // A title another issue of the publication already has is a duplicate.
    await ok(await send(w, `/v1/organizations/${ORG}/publications/${s.publication.id}/issues`, OWNER, { title: "Issue #143", publishOn: "2026-10-13" }), 201);
    const dup = await send(w, I, OWNER, { title: "issue #143" }, "PATCH");
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.details.reason).toBe("duplicate_name");
    expect((await send(w, I, OWNER, { status: "archived" }, "PATCH")).status).toBe(422);
    expect(auditTypes(w)).toContain("deal.issue.updated");
  });
});

describe("RB2 tenant boundary and roles", () => {
  it("every new org route answers 404 to a non-member; a viewer reads but cannot write", async () => {
    const w = world();
    const { deal, bookings, issue } = await bookedDeal(w);
    await ok(await send(w, `${D(deal.id)}/insertion-order`, OWNER, {}), 201);
    const { reportLink } = await ok(await send(w, `${D(deal.id)}/report-links`, OWNER, {}), 201);
    const routes: [string, string, unknown][] = [
      ["GET", `${D(deal.id)}/insertion-order`, undefined],
      ["POST", `${D(deal.id)}/insertion-order`, {}],
      ["PATCH", `${D(deal.id)}/insertion-order`, { terms: "x" }],
      ["POST", `${D(deal.id)}/insertion-order/send`, {}],
      ["PUT", `${D(deal.id)}/bookings/${bookings[0].id}/delivery`, { deliveredOn: "2026-10-06" }],
      ["POST", `${D(deal.id)}/report-links`, {}],
      ["DELETE", `${D(deal.id)}/report-links/${reportLink.id}`, undefined],
      ["PATCH", `/v1/organizations/${ORG}/issues/${issue.id}`, { title: "x" }],
    ];
    for (const who of [STRANGER, OTHER_OWNER]) {
      for (const [method, path, body] of routes) {
        const r = body === undefined ? await call(w, path, { method, headers: { "x-actor-subject-id": who, "x-actor-subject-type": "user" } }) : await send(w, path, who, body, method);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
    }
    for (const [method, path, body] of routes) {
      const r = body === undefined ? await call(w, path, { method, headers: { "x-actor-subject-id": VIEWER, "x-actor-subject-type": "user" } }) : await send(w, path, VIEWER, body, method);
      expect([method, path, r.status]).toEqual([method, path, method === "GET" ? 200 : 404]);
    }
    // The other org's owner cannot reach this org's deal through their own org either.
    expect((await get(w, `${D(deal.id, OTHER_ORG)}/insertion-order`, OTHER_OWNER)).status).toBe(404);
    expect(w.emails).toHaveLength(0);
  });
});
