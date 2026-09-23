import { DEAL_STAGES, DEAL_TRANSITIONS, NICHES, SLOT_FORMATS, canTransition, formatFitsKind } from "@saas/contracts/deal";

describe("deal contracts", () => {
  it("allows only forward single steps, lost before delivery, and reopening a lost deal", () => {
    expect(canTransition("lead", "pitched")).toBe(true);
    expect(canTransition("pitched", "booked")).toBe(true);
    expect(canTransition("booked", "delivered")).toBe(true);
    expect(canTransition("delivered", "paid")).toBe(true);
    expect(canTransition("lost", "lead")).toBe(true);
    for (const from of ["lead", "pitched", "booked"] as const) expect(canTransition(from, "lost")).toBe(true);
    expect(canTransition("lead", "booked")).toBe(false);
    expect(canTransition("booked", "pitched")).toBe(false);
    expect(canTransition("delivered", "lost")).toBe(false);
    expect(DEAL_TRANSITIONS.paid).toEqual([]);
    // every target is a known stage
    for (const s of DEAL_STAGES) for (const t of DEAL_TRANSITIONS[s]) expect(DEAL_STAGES).toContain(t);
  });

  it("matches slot formats to the publication's kind", () => {
    expect(formatFitsKind("nl_primary", "newsletter")).toBe(true);
    expect(formatFitsKind("pod_midroll", "newsletter")).toBe(false);
    expect(formatFitsKind("pod_midroll", "podcast")).toBe(true);
    expect(formatFitsKind("nl_dedicated", "podcast")).toBe(false);
    expect(formatFitsKind("other", "podcast")).toBe(true);
  });

  it("keeps the benchmark keys bounded: 15 niches and 7 formats besides other", () => {
    expect(NICHES.filter((n) => n !== "other")).toHaveLength(15);
    expect(SLOT_FORMATS.filter((f) => f !== "other")).toHaveLength(7);
  });
});
