"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TARGETS } from "@/lib/api";
import { SLOT_FORMAT_LABELS, type SponsorReport } from "@saas/contracts/deal";

/**
 * RB2: the sponsor's delivery report — public, no session. The token in the
 * path is the only credential; unknown, revoked and expired links all read
 * "not found".
 */
export default function SponsorReportPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [state, setState] = React.useState<{ loading: boolean; report: SponsorReport | null }>({ loading: true, report: null });

  React.useEffect(() => {
    const base = TARGETS[0]?.url ?? "";
    let alive = true;
    fetch(`${base}/ingress/rateboard/r/${encodeURIComponent(token)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(async (r) => (r.ok ? ((await r.json()) as { data: { report: SponsorReport } }).data.report : null))
      .catch(() => null)
      .then((report) => alive && setState({ loading: false, report }));
    return () => {
      alive = false;
    };
  }, [token]);

  if (state.loading) return <main className="mx-auto max-w-3xl p-6"><Skeleton className="h-40 w-full" /></main>;
  if (!state.report) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Not found</CardTitle>
            <CardDescription>This report link does not exist, or it has been revoked or has expired.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  const r = state.report;
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString());
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Delivery report</div>
        <h1 className="text-2xl font-semibold tracking-tight">{r.dealTitle}</h1>
        <p className="text-sm text-muted-foreground">Prepared for {r.sponsorName}. Figures are as reported by the publisher.</p>
      </header>
      <Card>
        <CardContent className="pt-4">
          {r.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No placements have been delivered yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Placement</TH>
                  <TH>Opens</TH>
                  <TH>Clicks</TH>
                  <TH>Downloads</TH>
                  <TH>Impressions</TH>
                </TR>
              </THead>
              <TBody>
                {r.lines.map((l, i) => (
                  <TR key={i}>
                    <TD className="whitespace-nowrap text-sm">{l.deliveredOn}</TD>
                    <TD>
                      <div className="font-medium">{l.publicationName} — {l.issueTitle}</div>
                      <div className="text-xs text-muted-foreground">
                        {l.slotLabel} · {SLOT_FORMAT_LABELS[l.format]}
                        {l.proofUrl ? (
                          <>
                            {" · "}
                            <a className="underline" href={l.proofUrl} rel="noopener noreferrer nofollow" target="_blank">proof</a>
                          </>
                        ) : null}
                      </div>
                    </TD>
                    <TD className="text-sm">{n(l.opens)}</TD>
                    <TD className="text-sm">{n(l.clicks)}</TD>
                    <TD className="text-sm">{n(l.downloads)}</TD>
                    <TD className="text-sm">{n(l.impressions)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
