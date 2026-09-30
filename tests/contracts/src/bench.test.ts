import { BENCH_BANDS, BENCH_FORMATS, BENCH_K, BENCH_NICHES, audienceBand, contributorBand } from "@saas/contracts/bench";
import { NICHES, SLOT_FORMATS } from "@saas/contracts/deal";

describe("bench contracts (RB3)", () => {
  it("has 525 disjoint cells: 15 niches × 5 bands × 7 formats, never `other`", () => {
    expect(BENCH_NICHES).toHaveLength(15);
    expect(BENCH_BANDS).toHaveLength(5);
    expect(BENCH_FORMATS).toHaveLength(7);
    expect(BENCH_NICHES.length * BENCH_BANDS.length * BENCH_FORMATS.length).toBe(525);
    expect([...BENCH_NICHES, "other"].sort()).toEqual([...NICHES].sort());
    expect([...BENCH_FORMATS, "other"].sort()).toEqual([...SLOT_FORMATS].sort());
  });

  it("puts every audience size in exactly one band, at fixed edges", () => {
    expect([1, 4_999, 5_000, 14_999, 15_000, 49_999, 50_000, 149_999, 150_000, 100_000_000].map(audienceBand)).toEqual([
      "lt5k", "lt5k", "5k_15k", "5k_15k", "15k_50k", "15k_50k", "50k_150k", "50k_150k", "150k_plus", "150k_plus",
    ]);
  });

  it("publishes a contributor band, never a count, and nothing below k = 5", () => {
    expect(BENCH_K).toBe(5);
    expect([0, 4, 5, 9, 10, 24, 25, 1000].map(contributorBand)).toEqual([null, null, "5–9", "5–9", "10–24", "10–24", "25+", "25+"]);
  });
});
