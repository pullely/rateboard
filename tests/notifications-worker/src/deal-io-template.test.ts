import { renderEmailTemplate } from "@notifications-worker/templates/index";

describe("deal.io.sent template (Rateboard RB2)", () => {
  const data = {
    ioNumber: "IO-0007",
    dealTitle: "Q4 launch",
    sponsorName: "Acme Analytics",
    contactName: "Dana",
    total: "1650.00 USD",
    paymentDueOn: "2026-11-15",
    terms: "Net 30. <b>No</b> competitor mentions.",
    placements: "2026-10-06 · The Stack Weekly · Issue #142 · Primary sponsor (Primary)\n2026-10-13 · The Stack Weekly · Issue #143 · Secondary sponsor (Secondary)",
  };

  it("is registered and renders the IO number, total, due date and each placement", () => {
    const r = renderEmailTemplate("deal.io.sent", data, { brandName: "Rateboard" });
    expect(r).not.toBeNull();
    expect(r!.subject).toBe("[Rateboard] IO-0007: Q4 launch");
    for (const needle of ["IO-0007", "1650.00 USD", "2026-11-15", "Issue #142", "Issue #143", "Hi Dana,"]) {
      expect(r!.text).toContain(needle);
      expect(r!.html).toContain(needle.replace("#", "#"));
    }
  });

  it("escapes every substituted value in the html body", () => {
    const r = renderEmailTemplate("deal.io.sent", data)!;
    expect(r.html).not.toContain("<b>No</b>");
    expect(r.html).toContain("&lt;b&gt;No&lt;/b&gt;");
  });
});
