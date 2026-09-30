"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { labelClass, money, selectClass } from "@/components/deals/format";
import {
  BENCH_BANDS,
  BENCH_BAND_LABELS,
  BENCH_FORMATS,
  BENCH_NICHES,
  type BenchCellResponse,
} from "@saas/contracts/bench";
import { NICHE_LABELS, SLOT_FORMAT_LABELS } from "@saas/contracts/deal";

/**
 * RB3: the opt-in rate benchmarks. The consent switch (owner or admin) with
 * the exact list of what is shared, and — for a contributing org — the
 * published cells and a one-cell lookup by exact key.
 */
export default function BenchmarksPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const consent = useApiQuery(qk.benchContribution(orgId), () => wrap(async () => client.bench.getContribution(orgId)));
  const [busy, setBusy] = React.useState(false);
  const contributing = consent.data?.contribution.contributing ?? false;

  async function toggle() {
    setBusy(true);
    const r = await wrap(async () => (contributing ? client.bench.revoke(orgId) : client.bench.optIn(orgId)));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not change the contribution", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: contributing ? "Contribution revoked" : "Contributing to the benchmarks" });
    consent.reload();
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Rate benchmarks</h1>
        <p className="text-sm text-muted-foreground">
          What comparable creators charge, from the deals of creators who chose to contribute. Contribute to see them.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Your contribution {consent.data ? <Badge variant={contributing ? "success" : "secondary"}>{contributing ? "On" : "Off"}</Badge> : null}
          </CardTitle>
          <CardDescription>Only an owner or admin can change this.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {consent.loading ? (
            <Skeleton className="h-20 w-full" />
          ) : consent.error ? (
            <p className="text-muted-foreground">Only an owner or admin of this organization can manage its benchmark contribution.</p>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5">
                {consent.data!.shares.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              {contributing && consent.data!.contribution.countsFrom ? (
                <p className="text-muted-foreground">Your bookings count from {consent.data!.contribution.countsFrom.slice(0, 10)}.</p>
              ) : null}
              <Button size="sm" variant={contributing ? "outline" : "default"} disabled={busy} onClick={() => void toggle()}>
                {contributing ? "Revoke my contribution" : "Contribute and see benchmarks"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Cells orgId={orgId} />
    </div>
  );
}

function Cells({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const cells = useApiQuery(qk.benchCells(orgId), () => wrap(async () => client.bench.listCells(orgId)));
  const [niche, setNiche] = React.useState<string>("tech");
  const [band, setBand] = React.useState<string>("15k_50k");
  const [format, setFormat] = React.useState<string>("nl_primary");
  const [cell, setCell] = React.useState<BenchCellResponse | null>(null);

  async function look(e: React.FormEvent) {
    e.preventDefault();
    const r = await wrap(async () => client.bench.getCell(orgId, { niche, band, format }));
    setCell(r.ok ? r.data : null);
  }

  if (cells.loading) return <Skeleton className="h-32 w-full" />;
  if (cells.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Benchmarks</CardTitle>
          <CardDescription>Benchmarks are visible to organizations that contribute.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const data = cells.data!;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Benchmarks {data.snapshot ? <span className="text-sm font-normal text-muted-foreground">· {data.snapshot}</span> : null}</CardTitle>
        <CardDescription>
          A cell is published only with at least five independent contributors, as rounded percentiles of one value per contributor.
          {data.cells.length ? ` ${data.cells.length} cell(s) published.` : " No cell is published yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {data.cells.length ? (
          <ul className="space-y-1">
            {data.cells.map((c) => (
              <li key={`${c.niche}|${c.band}|${c.format}`}>
                {NICHE_LABELS[c.niche]} · {BENCH_BAND_LABELS[c.band]} · {SLOT_FORMAT_LABELS[c.format]} <Badge variant="secondary">{c.contributors} contributors</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={look} className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <div>
            <label className={labelClass} htmlFor="bn">Niche</label>
            <select id="bn" className={selectClass} value={niche} onChange={(e) => setNiche(e.target.value)}>
              {BENCH_NICHES.map((n) => <option key={n} value={n}>{NICHE_LABELS[n]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="bb">Audience</label>
            <select id="bb" className={selectClass} value={band} onChange={(e) => setBand(e.target.value)}>
              {BENCH_BANDS.map((b) => <option key={b} value={b}>{BENCH_BAND_LABELS[b]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="bf">Format</label>
            <select id="bf" className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
              {BENCH_FORMATS.map((f) => <option key={f} value={f}>{SLOT_FORMAT_LABELS[f]}</option>)}
            </select>
          </div>
          <Button type="submit">Look up</Button>
        </form>
        {cell ? (
          cell.published ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <div className="font-medium">Price per slot</div>
                <div>25th {money(cell.flat.p25, "USD")} · median {money(cell.flat.p50, "USD")} · 75th {money(cell.flat.p75, "USD")}</div>
              </div>
              <div>
                <div className="font-medium">Effective CPM</div>
                <div>25th {money(cell.cpm.p25, "USD")} · median {money(cell.cpm.p50, "USD")} · 75th {money(cell.cpm.p75, "USD")}</div>
              </div>
              <div className="text-xs text-muted-foreground">{cell.contributors} contributors · {cell.snapshot}</div>
            </div>
          ) : (
            <p className="text-muted-foreground">Not enough independent contributors in this cell yet.</p>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
