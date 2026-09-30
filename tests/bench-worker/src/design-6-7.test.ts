/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BENCH_BANDS, BENCH_FORMATS, BENCH_K, BENCH_NICHES, audienceBand } from "@saas/contracts/bench";
import type { ContributedBooking } from "@saas/db/bench";
import { K, cellKeyOf, computeSnapshot, diffSize, memberOf, round2sf } from "@bench-worker/aggregate";
import {
  CELL,
  LONG_AGO,
  NOW,
  REPO_ROOT,
  addBooking,
  call,
  cellData,
  contributor,
  grant,
  optIn,
  orgPublic,
  repo,
  run,
  uuid,
  world,
  type World,
} from "./harness";

// Epic design §6.7 — the eight tests RB3 must carry, over real SQLite.

const EMPTY_CELL = { niche: "gaming", band: "lt5k", format: "pod_postroll" } as const;

/** A member of a contributing org who reads: opt-in an extra org so reads are allowed. */
function reader(w: World): { org: string; owner: string } {
  return contributor(w, [], { optedInAt: LONG_AGO });
}

describe("§6.7.1 threshold", () => {
  it("k is pinned at 5", () => {
    expect(BENCH_K).toBe(5);
    expect(K).toBe(5);
  });

  it("4 eligible contributors do not publish, and the answer equals an empty cell's byte for byte; 5 do", async () => {
    const w = world();
    const me = reader(w);
    for (let i = 0; i < 4; i++) contributor(w, [50_000 + i * 1000, 51_000, 52_000]);
    await run(w);
    const four = await cellData(w, me.org, me.owner, CELL);
    const empty = await cellData(w, me.org, me.owner, EMPTY_CELL);
    expect(four).toBe('{"published":false}');
    expect(four).toBe(empty);

    contributor(w, [60_000, 61_000, 62_000]);
    await run(w, "2026-10-12T04:00:00.000Z");
    const five = JSON.parse(await cellData(w, me.org, me.owner, CELL));
    expect(five.published).toBe(true);
    expect(five.contributors).toBe("5–9");
  });
});

describe("§6.7.2 no rows", () => {
  it("the published table has exactly the §6.5 columns, and a published response carries no org id, count, min, max or mean", async () => {
    const w = world();
    const cols = (w.db.prepare("PRAGMA table_info(bench_cells)").all() as { name: string }[]).map((c) => c.name).sort();
    expect(cols).toEqual(
      ["snapshot", "niche", "band", "format", "flat_p25", "flat_p50", "flat_p75", "cpm_p25", "cpm_p50", "cpm_p75", "contributors"].sort(),
    );

    const me = reader(w);
    const orgs = [];
    for (let i = 0; i < 6; i++) orgs.push(contributor(w, [40_000 + i * 3_000, 45_000, 47_000]).org);
    await run(w);
    const text = await cellData(w, me.org, me.owner, CELL);
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["band", "contributors", "cpm", "flat", "format", "niche", "published", "snapshot"]);
    expect(Object.keys(body.flat).sort()).toEqual(["p25", "p50", "p75"]);
    expect(Object.keys(body.cpm).sort()).toEqual(["p25", "p50", "p75"]);
    expect(typeof body.contributors).toBe("string");
    for (const org of [...orgs, me.org]) {
      expect(text).not.toContain(org);
      expect(text).not.toContain(org.replace(/-/g, ""));
    }
    expect(text).not.toMatch(/count|min|max|mean|avg|org/i);

    const list = await call(w, "GET", `/v1/organizations/${orgPublic(me.org)}/benchmarks/cells`, me.owner);
    expect(list.status).toBe(200);
    expect(list.body.data.cells).toEqual([{ niche: "tech", band: "15k_50k", format: "nl_primary", contributors: "5–9" }]);
    expect(list.text).not.toMatch(/count|min|max|mean/i);
  });
});

describe("§6.7.3 dominance", () => {
  it("one org with 50 bookings at $10,000 and four orgs at about $500 publishes p75 ≈ $500", async () => {
    const w = world();
    const me = reader(w);
    contributor(w, Array(50).fill(1_000_000));
    for (const p of [49_000, 50_000, 51_000, 52_000]) contributor(w, [p, p, p]);
    await run(w);
    const cell = JSON.parse(await cellData(w, me.org, me.owner, CELL));
    expect(cell.published).toBe(true);
    expect(cell.flat.p75).toBeGreaterThanOrEqual(47_500);
    expect(cell.flat.p75).toBeLessThanOrEqual(52_500);
    expect(cell.flat.p50).toBe(51_000);
  });

  it("rounds every percentile to two significant figures", () => {
    expect(round2sf(51_234)).toBe(51_000);
    expect(round2sf(5_049)).toBe(5_000);
    expect(round2sf(5_050)).toBe(5_100);
    expect(round2sf(987)).toBe(990);
    expect(round2sf(1_234_567)).toBe(1_200_000);
  });
});

describe("§6.7.4 query differencing", () => {
  function randomBookings(n: number, seed: number): (ContributedBooking & { id: number })[] {
    let s = seed;
    const rnd = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    return Array.from({ length: n }, (_, id) => ({
      id,
      orgId: `org-${Math.floor(rnd() * 40)}`,
      niche: pick(BENCH_NICHES),
      format: pick(BENCH_FORMATS),
      audienceSize: 1 + Math.floor(rnd() * 400_000),
      priceCents: 1_000 + Math.floor(rnd() * 2_000_000),
      currency: "USD",
      optedInAt: LONG_AGO,
    }));
  }

  it("every qualifying booking maps to exactly one of the 525 cells", () => {
    const keys = BENCH_NICHES.flatMap((n) => BENCH_BANDS.flatMap((b) => BENCH_FORMATS.map((f) => `${n}|${b}|${f}`)));
    expect(keys).toHaveLength(525);
    expect(new Set(keys).size).toBe(525);
    for (const b of randomBookings(2_000, 7)) {
      const matches = keys.filter((k) => {
        const [n, band, f] = k.split("|");
        return b.niche === n && audienceBand(b.audienceSize) === band && b.format === f;
      });
      expect(matches).toEqual([cellKeyOf(b)]);
    }
  });

  it("for every pair of published cells in a generated dataset, the bookings behind them are disjoint", async () => {
    // Few niches/formats so many cells reach k.
    const bookings = randomBookings(3_000, 11).map((b) => ({ ...b, niche: b.niche < "m" ? "tech" : "finance", format: b.id % 2 ? "nl_primary" : "pod_midroll" }));
    const members = new Map<string, string>();
    for (const b of bookings) if (!members.has(b.orgId)) members.set(b.orgId, await memberOf(b.orgId));
    const out = computeSnapshot({ bookings, admins: [], now: NOW, minOptinDays: 30, published: new Map(), members, snapshot: "2026-W41" });
    expect(out.cells.length).toBeGreaterThan(3);
    const behind = new Map<string, Set<number>>();
    for (const c of out.cells) behind.set(`${c.niche}|${c.band}|${c.format}`, new Set());
    for (const b of bookings) behind.get(cellKeyOf(b))?.add(b.id);
    const sets = [...behind.values()];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        for (const id of sets[i]!) expect(sets[j]!.has(id)).toBe(false);
      }
    }
  });

  it("the read route refuses any query without all three exact keys (422)", async () => {
    const w = world();
    const me = reader(w);
    const base = `/v1/organizations/${orgPublic(me.org)}/benchmarks`;
    for (const q of [
      "",
      "?niche=tech",
      "?niche=tech&band=15k_50k",
      "?niche=tech&band=15k_50k&format=*",
      "?niche=*&band=15k_50k&format=nl_primary",
      "?niche=tech&band=all&format=nl_primary",
      "?niche=other&band=15k_50k&format=nl_primary",
      "?niche=tech&band=15k_50k&format=nl_primary&niche=finance",
      "?niche=tech&band=15k_50k&format=nl_primary&rollup=1",
    ]) {
      const r = await call(w, "GET", `${base}${q}`, me.owner);
      expect([q, r.status]).toEqual([q, 422]);
    }
    expect((await call(w, "GET", `${base}?niche=tech&band=15k_50k&format=nl_primary`, me.owner)).status).toBe(200);
  });
});

describe("§6.7.5 snapshot differencing and revocation", () => {
  it("6 publish; one revokes → the next run withholds and never reads the revoker; a second change republishes", async () => {
    const w = world();
    const me = reader(w);
    const six = Array.from({ length: 6 }, (_, i) => contributor(w, [40_000 + i * 2_000, 44_000, 46_000]));
    const first = await run(w, "2026-10-05T04:00:00.000Z");
    expect(first!.output.cells.map((c) => `${c.niche}|${c.band}|${c.format}`)).toEqual(["tech|15k_50k|nl_primary"]);
    expect(JSON.parse(await cellData(w, me.org, me.owner, CELL)).published).toBe(true);

    // The revoker uses the route (owner-only), like a real user.
    const revoker = six[5]!;
    const r = await call(w, "DELETE", `/v1/organizations/${orgPublic(revoker.org)}/benchmark-contribution`, revoker.owner);
    expect(r.status).toBe(200);
    expect(r.body.data.contribution.contributing).toBe(false);

    // The one cross-tenant read no longer returns a single row of the revoker's.
    const read = await repo(w).readContributedBookings({ since: "2025-10-05T00:00:00.000Z" });
    expect(read.some((b) => b.orgId === revoker.org)).toBe(false);

    const second = await run(w, "2026-10-12T04:00:00.000Z");
    expect(second!.output.inputOrgs.has(revoker.org)).toBe(false);
    expect(second!.output.reasons.get("tech|15k_50k|nl_primary")).toBe("change_by_one");
    expect(await cellData(w, me.org, me.owner, CELL)).toBe('{"published":false}');

    // A second org changes (a new contributor joins): the set now differs from
    // the published one by two orgs, and the cell republishes without the revoker.
    contributor(w, [48_000, 48_000, 48_000]);
    const third = await run(w, "2026-10-19T04:00:00.000Z");
    expect(third!.output.inputOrgs.has(revoker.org)).toBe(false);
    expect(JSON.parse(await cellData(w, me.org, me.owner, CELL)).published).toBe(true);
  });

  it("property: over random join and revoke sequences, no two published versions of a cell differ by exactly one org", async () => {
    for (let trial = 0; trial < 25; trial++) {
      let s = 1000 + trial;
      const rnd = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
      const pool = Array.from({ length: 12 }, (_, i) => `org-${trial}-${i}`);
      const members = new Map<string, string>();
      for (const o of pool) members.set(o, await memberOf(o));
      const live = new Set<string>(pool.filter(() => rnd() < 0.5));
      const history = new Map<string, Map<string, Set<string>>>();
      const versions: Set<string>[] = [];
      for (let step = 0; step < 40; step++) {
        // each step: 0–3 orgs flip (join or revoke)
        const flips = Math.floor(rnd() * 4);
        for (let f = 0; f < flips; f++) {
          const o = pool[Math.floor(rnd() * pool.length)]!;
          if (live.has(o)) live.delete(o);
          else live.add(o);
        }
        const bookings: ContributedBooking[] = [...live].flatMap((orgId, i) =>
          [0, 1, 2].map(() => ({ orgId, niche: "tech", format: "nl_primary", audienceSize: 24_000, priceCents: 40_000 + i * 997, currency: "USD", optedInAt: LONG_AGO })),
        );
        const snapshot = `S${step}`;
        const out = computeSnapshot({ bookings, admins: [], now: NOW, minOptinDays: 30, published: history, members, snapshot });
        for (const m of out.memberRows) {
          const cell = history.get(m.cellKey) ?? history.set(m.cellKey, new Map()).get(m.cellKey)!;
          (cell.get(m.snapshot) ?? cell.set(m.snapshot, new Set()).get(m.snapshot)!).add(m.member);
        }
        const v = history.get("tech|15k_50k|nl_primary")?.get(snapshot);
        if (v) versions.push(v);
      }
      expect(versions.length).toBeGreaterThan(0);
      for (let i = 0; i < versions.length; i++) {
        for (let j = i + 1; j < versions.length; j++) expect(diffSize(versions[i]!, versions[j]!)).not.toBe(1);
      }
    }
  });
});

describe("§6.7.6 recovery attempt", () => {
  /**
   * Everything a curious contributor can read in one snapshot: every cell's
   * response, by exact key, from the read route. Two queries or two
   * snapshots, differenced, are functions of these strings.
   */
  async function everything(w: World, me: { org: string; owner: string }): Promise<string[]> {
    const out: string[] = [];
    for (const niche of ["tech", "finance"]) for (const format of ["nl_primary", "nl_secondary"]) {
      out.push(await cellData(w, me.org, me.owner, { niche, band: "15k_50k", format }));
    }
    return out;
  }

  async function scenario(targetPrice: number, mode: "join" | "revoke"): Promise<string[]> {
    const w = world();
    const me = reader(w);
    // Five others in the target's cell, and five in a neighbouring cell (a second query to difference against).
    for (let i = 0; i < 5; i++) contributor(w, [40_000 + i * 2_500, 42_000, 44_000]);
    for (let i = 0; i < 5; i++) contributor(w, [30_000 + i * 1_500, 31_000, 33_000], { format: "nl_secondary" });
    const outputs: string[] = [];
    let target: { org: string } | null = null;
    if (mode === "revoke") target = contributor(w, [targetPrice, targetPrice, targetPrice]);
    await run(w, "2026-10-05T04:00:00.000Z");
    const s1 = await everything(w, me);
    if (mode === "join") target = contributor(w, [targetPrice, targetPrice, targetPrice]);
    else w.db.prepare("UPDATE bench_contributions SET revoked_at = ? WHERE org_id = ?").run("2026-10-06T00:00:00.000Z", target!.org);
    await run(w, "2026-10-12T04:00:00.000Z");
    const s2 = await everything(w, me);
    outputs.push(...s1.map((x) => `S1 ${x}`), ...s2.map((x) => `S2 ${x}`));
    return outputs;
  }

  it("join: across two snapshots in which only the target changed, the outputs do not depend on the target's value at all", async () => {
    const baseline = await scenario(45_000, "join");
    for (const alternative of [1_000, 45_001, 99_000, 5_000_000]) {
      expect(await scenario(alternative, "join")).toEqual(baseline);
    }
    // …and the pair is not trivially empty: snapshot 1 published the target's cell.
    expect(baseline[0]).toContain('"published":true');
    expect(baseline[4]).toBe('S2 {"published":false}');
  });

  it("revoke: the snapshot after the target left carries nothing that depends on the target alone", async () => {
    const a = await scenario(45_000, "revoke");
    const b = await scenario(9_000_000, "revoke");
    // Snapshot 2 (after the revoke): identical whatever the target's value was, and the target's cell withheld.
    expect(a.slice(4)).toEqual(b.slice(4));
    expect(a[4]).toBe('S2 {"published":false}');
    // Snapshot 1 is the ordinary k-anonymous publication (the target among six); no second
    // query or later snapshot pairs with it to isolate the target, because the neighbouring
    // cell is disjoint and never changes, and the target's cell is withheld afterwards.
    expect(a.slice(1, 4).map((x) => x.replace(/"snapshot":"[^"]+"/, ""))).toEqual(b.slice(1, 4).map((x) => x.replace(/"snapshot":"[^"]+"/, "")));
  });
});

describe("§6.7.7 consent", () => {
  it("a non-contributing org gets 404 on the read routes; no contribution route accepts a builder or viewer", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) contributor(w, [40_000, 41_000, 42_000]);
    await run(w);
    const org = uuid();
    const owner = uuid();
    const admin = uuid();
    const builder = uuid();
    const viewer = uuid();
    grant(w, org, owner, "owner");
    grant(w, org, admin, "admin");
    grant(w, org, builder, "builder");
    grant(w, org, viewer, "viewer");
    const O = `/v1/organizations/${orgPublic(org)}`;
    for (const who of [owner, admin, builder, viewer]) {
      expect((await call(w, "GET", `${O}/benchmarks/cells`, who)).status).toBe(404);
      expect((await call(w, "GET", `${O}/benchmarks?niche=tech&band=15k_50k&format=nl_primary`, who)).status).toBe(404);
    }
    for (const who of [builder, viewer]) {
      for (const method of ["GET", "PUT", "DELETE"]) expect([who, method, (await call(w, method, `${O}/benchmark-contribution`, who)).status]).toEqual([who, method, 404]);
    }
    const stranger = uuid();
    expect((await call(w, "PUT", `${O}/benchmark-contribution`, stranger)).status).toBe(404);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM bench_contributions WHERE org_id = ?").get(org) as { n: number }).n).toBe(0);

    // An admin opts in (201), the shares list is returned, and now every role reads.
    const opted = await call(w, "PUT", `${O}/benchmark-contribution`, admin);
    expect(opted.status).toBe(201);
    expect(opted.body.data.contribution.contributing).toBe(true);
    expect(opted.body.data.shares.length).toBeGreaterThan(0);
    expect((await call(w, "PUT", `${O}/benchmark-contribution`, owner)).status).toBe(200); // already in
    for (const who of [owner, admin, builder, viewer]) expect((await call(w, "GET", `${O}/benchmarks/cells`, who)).status).toBe(200);
    // The owner revokes; reads close again; re-opting in is a new consent.
    expect((await call(w, "DELETE", `${O}/benchmark-contribution`, owner)).status).toBe(200);
    expect((await call(w, "GET", `${O}/benchmarks/cells`, viewer)).status).toBe(404);
    expect((await call(w, "DELETE", `${O}/benchmark-contribution`, owner)).status).toBe(404);
    const again = await call(w, "PUT", `${O}/benchmark-contribution`, owner);
    expect(again.status).toBe(201);
    expect(again.body.data.contribution.optedInAt > opted.body.data.contribution.optedInAt).toBe(true);
    const events = (w.db.prepare("SELECT type FROM events_event_log WHERE org_id = ? ORDER BY rowid").all(org) as { type: string }[]).map((e) => e.type);
    expect(events).toEqual(["bench.contribution.opted_in", "bench.contribution.revoked", "bench.contribution.opted_in"]);
  });
});

describe("§6.7.8 boundary", () => {
  function methodsOf(source: string, iface: string): { name: string; params: string }[] {
    const start = source.indexOf(`export interface ${iface} {`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const out: { name: string; params: string }[] = [];
    const re = /^\s{2}(\w+)\(([\s\S]*?)\):\s*Promise</gm;
    for (let m = re.exec(body); m; m = re.exec(body)) out.push({ name: m[1]!, params: m[2]! });
    return out;
  }

  it("readContributedBookings is the only repository function over deal_* tables without an orgId (the RB2 report lookup is token-keyed)", () => {
    const db = join(REPO_ROOT, "packages/db/src");
    const repos: [string, string][] = [
      ["deal/types.ts", "DealRepository"],
      ["deal/paperwork-types.ts", "PaperworkRepository"],
      ["bench/types.ts", "BenchRepository"],
    ];
    const allTypes = repos.map(([file]) => readFileSync(join(db, file), "utf8")).join("\n");
    // A parameter typed by a named input (e.g. `input: MoveStageInput`) carries orgId when that type declares it.
    const typeHasOrgId = (name: string): boolean => {
      const m = new RegExp(`(?:interface|type)\\s+${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(allTypes);
      return !!m && /\borgId\b/.test(m[1]!);
    };
    const withoutOrg: string[] = [];
    for (const [file, iface] of repos) {
      for (const m of methodsOf(readFileSync(join(db, file), "utf8"), iface)) {
        const named = [...m.params.matchAll(/:\s*([A-Z]\w+)/g)].map((x) => x[1]!);
        if (!/orgId/.test(m.params) && !named.some(typeHasOrgId)) withoutOrg.push(`${iface}.${m.name}`);
      }
    }
    // Of these, only the bench ones below touch deal_* tables at all; each bench
    // method's SQL is checked next.
    expect(withoutOrg.filter((n) => n.startsWith("DealRepository") || n.startsWith("PaperworkRepository"))).toEqual(["PaperworkRepository.openReportLink"]);

    // In the bench repository, deal_* appears inside readContributedBookings and nowhere else.
    const src = readFileSync(join(db, "bench/repository.ts"), "utf8");
    const startRead = src.indexOf("async readContributedBookings(");
    const endRead = src.indexOf("async readOrgAdmins(");
    expect(startRead).toBeGreaterThan(-1);
    const outside = src.slice(0, startRead) + src.slice(endRead);
    expect(outside).not.toMatch(/\bdeal_/);
    expect(src.slice(startRead, endRead)).toMatch(/JOIN bench_contributions c ON c\.org_id = b\.org_id AND c\.revoked_at IS NULL/);

    // No other file in packages/db reads deal_* without an org filter via a bench-like read.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(db);
    const defining = files.filter((f) => /readContributedBookings\s*\(/.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => f.slice(db.length + 1)).sort()).toEqual(["bench/repository.ts", "bench/types.ts"]);
  });

  it("deal-worker does not import the bench context or the cross-tenant read", () => {
    const root = join(REPO_ROOT, "apps/deal-worker/src");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(root)) {
      const text = readFileSync(f, "utf8");
      expect([f, /@saas\/db\/bench|readContributedBookings|bench_/.test(text)]).toEqual([f, false]);
    }
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/deal-worker/package.json"), "utf8"));
    expect(JSON.stringify(pkg)).not.toContain("bench");
  });
});

describe("eligibility, sybil resistance and the stage override", () => {
  it("orgs sharing an owner count once (usr_ and UUID forms alike, trap 39); 4 owners over 5 orgs do not publish", async () => {
    const w = world();
    const me = reader(w);
    const shared = uuid();
    contributor(w, [40_000, 41_000, 42_000], { owner: shared });
    const twin = contributor(w, [90_000, 91_000, 92_000]);
    // The twin's owner is ALSO an admin of the first org — stored in the public usr_ form.
    grant(w, twin.org, `usr_${shared.replace(/-/g, "")}`, "admin");
    for (let i = 0; i < 3; i++) contributor(w, [50_000 + i * 1000, 51_000, 52_000]);
    const out = await run(w);
    expect(out!.output.reasons.get("tech|15k_50k|nl_primary")).toBe("below_k");
    expect(await cellData(w, me.org, me.owner, CELL)).toBe('{"published":false}');
    contributor(w, [60_000, 61_000, 62_000]);
    await run(w, "2026-10-12T04:00:00.000Z");
    expect(JSON.parse(await cellData(w, me.org, me.owner, CELL)).published).toBe(true);
  });

  it("an org counts only 30 days after opting in and with ≥ 3 qualifying USD bookings", async () => {
    const w = world();
    const me = reader(w);
    for (let i = 0; i < 4; i++) contributor(w, [40_000 + i, 41_000, 42_000]);
    const fresh = contributor(w, [43_000, 44_000, 45_000], { optedInAt: "2026-09-10T00:00:00.000Z" }); // 25 days before NOW
    const thin = contributor(w, [43_000, 44_000]); // two bookings
    addBooking(w, thin.org, { price: 45_000, currency: "EUR" }); // not USD: does not qualify
    const first = await run(w);
    expect(first!.output.inputOrgs.has(fresh.org)).toBe(false);
    expect(first!.output.inputOrgs.has(thin.org)).toBe(false);
    expect(await cellData(w, me.org, me.owner, CELL)).toBe('{"published":false}');
    // With the stage override (0 days), the fresh org counts.
    const second = await run(w, "2026-10-05T05:00:00.000Z", 0);
    expect(second!.output.inputOrgs.has(fresh.org)).toBe(true);
    expect(second!.snapshot).toBe("2026-W41.2");
    expect(JSON.parse(await cellData(w, me.org, me.owner, CELL)).published).toBe(true);
  });

  it("a failed run leaves the previous snapshot serving; reads serve only the latest completed one", async () => {
    const w = world();
    const me = reader(w);
    for (let i = 0; i < 5; i++) contributor(w, [40_000 + i * 1000, 41_000, 42_000]);
    await run(w);
    const before = await cellData(w, me.org, me.owner, CELL);
    const r = repo(w);
    const broken = { ...r, writeCells: async () => { throw new Error("boom"); } };
    const { runAggregate } = await import("@bench-worker/run");
    await expect(runAggregate(broken, { now: "2026-10-12T04:00:00.000Z", minOptinDays: 30 })).rejects.toThrow("boom");
    expect(await cellData(w, me.org, me.owner, CELL)).toBe(before);
    const runs = w.db.prepare("SELECT status FROM bench_runs ORDER BY rowid").all() as { status: string }[];
    expect(runs.map((x) => x.status)).toEqual(["done", "failed"]);
    // Operator totals exist, and no route serves them.
    expect((w.db.prepare("SELECT contributors, cells_published FROM bench_runs WHERE status = 'done'").get() as any).cells_published).toBe(1);
  });

  it("the override is stage-only: prod ignores it, and the prod wrangler block has neither it nor a fast cron", async () => {
    const { minOptinDays } = await import("@bench-worker/config");
    expect(minOptinDays({ ENVIRONMENT: "prod", BENCH_MIN_OPTIN_DAYS: "0" })).toBe(30);
    expect(minOptinDays({ ENVIRONMENT: "stage", BENCH_MIN_OPTIN_DAYS: "0" })).toBe(0);
    expect(minOptinDays({ ENVIRONMENT: "stage" })).toBe(30);
    expect(minOptinDays({ ENVIRONMENT: "stage", BENCH_MIN_OPTIN_DAYS: "-1" })).toBe(30);
    const raw = readFileSync(join(REPO_ROOT, "apps/bench-worker/wrangler.template.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(raw) as { env: Record<string, { vars: Record<string, string>; triggers: { crons: string[] }; workers_dev: boolean }> };
    expect(cfg.env.prod!.vars).toEqual({ ENVIRONMENT: "prod" });
    expect(cfg.env.prod!.triggers.crons).toEqual(["0 4 * * 1"]);
    expect(cfg.env.prod!.workers_dev).toBe(false);
    expect(cfg.env.stage!.vars.BENCH_MIN_OPTIN_DAYS).toBe("0");
    expect(cfg.env.stage!.workers_dev).toBe(false);
  });
});

// Keep the run helper's unused import list honest.
void optIn;
