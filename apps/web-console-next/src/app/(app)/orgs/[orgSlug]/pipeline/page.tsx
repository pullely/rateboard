"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SquareKanban } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { labelClass, money, selectClass, toCents } from "@/components/deals/format";
import { DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage, type PublicDeal, type PublicSponsor } from "@saas/contracts/deal";

export default function PipelinePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const deals = useApiQuery(qk.deals(orgId), () => wrap(async () => (await client.deals.listDeals(orgId)).deals));
  const sponsors = useApiQuery(qk.sponsors(orgId), () => wrap(async () => (await client.deals.listSponsors(orgId)).sponsors));
  const [creating, setCreating] = React.useState(false);

  const byStage = React.useMemo(() => {
    const m = new Map<DealStage, PublicDeal[]>(DEAL_STAGES.map((s) => [s, []]));
    for (const d of deals.data ?? []) m.get(d.stage)?.push(d);
    return m;
  }, [deals.data]);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Every sponsor deal from first contact to paid. A deal is booked only once it holds a slot on the inventory calendar.
          </p>
        </div>
        {!creating && <Button onClick={() => setCreating(true)}>New deal</Button>}
      </header>

      {creating && (
        <DealForm
          orgId={orgId}
          sponsors={sponsors.data ?? []}
          onDone={() => {
            setCreating(false);
            deals.reload();
            sponsors.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {deals.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : deals.error ? (
        <p className="text-sm text-destructive">{deals.error.message}</p>
      ) : (deals.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
            <SquareKanban className="h-8 w-8 mb-3 text-primary" />
            No deals yet. Log your first lead, then book it into a slot on the inventory calendar.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {DEAL_STAGES.map((stage) => {
            const list = byStage.get(stage) ?? [];
            const totals = new Map<string, number>();
            for (const d of list) if (d.valueCents !== null) totals.set(d.currency, (totals.get(d.currency) ?? 0) + d.valueCents);
            return (
              <Card key={stage} className="min-h-40">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    {DEAL_STAGE_LABELS[stage]} <span className="text-muted-foreground">· {list.length}</span>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {[...totals.entries()].map(([c, v]) => money(v, c)).join(" + ") || "—"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {list.map((d) => (
                    <Link
                      key={d.id}
                      href={`/orgs/${orgSlug}/deals/${d.id}`}
                      className="block rounded-md border p-2 text-sm hover:bg-muted"
                    >
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.sponsorName} · {money(d.valueCents, d.currency)}
                        {d.liveBookings > 0 ? ` · ${d.liveBookings} slot${d.liveBookings === 1 ? "" : "s"}` : ""}
                      </div>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DealForm({
  orgId,
  sponsors,
  onDone,
  onCancel,
}: {
  orgId: string;
  sponsors: PublicSponsor[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({ title: "", sponsorId: "", sponsorName: "", value: "", currency: "USD" });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const valueCents = toCents(form.value);
    if (Number.isNaN(valueCents)) {
      toast({ kind: "error", title: "The value is not a number" });
      return;
    }
    setBusy(true);
    const r = await wrap(async () =>
      client.deals.createDeal(orgId, {
        title: form.title,
        ...(form.sponsorId ? { sponsorId: form.sponsorId } : { sponsorName: form.sponsorName }),
        valueCents,
        currency: form.currency,
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not save the deal", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Lead logged", description: "Open it to book slots and move it through the pipeline." });
    onDone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New deal</CardTitle>
        <CardDescription>Every deal starts as a lead. Pick a sponsor you know, or type a new one.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="d-title">Deal</label>
            <Input id="d-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Q4 launch — two primary slots" required />
          </div>
          <div>
            <label className={labelClass} htmlFor="d-sponsor">Sponsor</label>
            <select id="d-sponsor" className={selectClass} value={form.sponsorId} onChange={(e) => set("sponsorId", e.target.value)}>
              <option value="">New sponsor…</option>
              {sponsors.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          {!form.sponsorId && (
            <div>
              <label className={labelClass} htmlFor="d-sponsor-name">New sponsor name</label>
              <Input id="d-sponsor-name" value={form.sponsorName} onChange={(e) => set("sponsorName", e.target.value)} required />
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="d-value">Agreed value</label>
            <Input id="d-value" inputMode="decimal" value={form.value} onChange={(e) => set("value", e.target.value)} placeholder="1,200" />
          </div>
          <div>
            <label className={labelClass} htmlFor="d-currency">Currency</label>
            <Input id="d-currency" value={form.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
          </div>
          <div className="mt-5 flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save lead"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
