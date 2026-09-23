"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { StageBadge, labelClass, money, selectClass, toCents } from "@/components/deals/format";
import {
  NICHES,
  NICHE_LABELS,
  SLOT_FORMAT_LABELS,
  type Niche,
  type PublicPublication,
  type PublicationKind,
  type SlotFormat,
} from "@saas/contracts/deal";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function InventoryPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [offsetWeeks, setOffsetWeeks] = React.useState(0);
  const from = iso(new Date(Date.now() + offsetWeeks * 7 * DAY));
  const to = iso(new Date(Date.now() + (offsetWeeks + 8) * 7 * DAY));
  const publications = useApiQuery(qk.publications(orgId), () =>
    wrap(async () => (await client.deals.listPublications(orgId, { status: "active" })).publications),
  );
  const inventory = useApiQuery(qk.inventory(orgId, `${from}:${to}`), () => wrap(async () => client.deals.inventory(orgId, { from, to })));
  const [adding, setAdding] = React.useState<"publication" | "issue" | null>(null);

  const reloadAll = () => {
    setAdding(null);
    publications.reload();
    inventory.reload();
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Every issue and episode with its ad slots. A booked slot names its sponsor; nothing can be sold twice.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setAdding("publication")}>Add publication</Button>
          <Button onClick={() => setAdding("issue")} disabled={(publications.data ?? []).length === 0}>Add issue</Button>
        </div>
      </header>

      {adding === "publication" && <PublicationForm orgId={orgId} onDone={reloadAll} onCancel={() => setAdding(null)} />}
      {adding === "issue" && (
        <IssueForm orgId={orgId} publications={publications.data ?? []} onDone={reloadAll} onCancel={() => setAdding(null)} />
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{from} → {to}</CardTitle>
            <CardDescription>{(publications.data ?? []).map((p) => p.name).join(" · ") || "No publications yet"}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setOffsetWeeks((w) => w - 8)}>Earlier</Button>
            <Button size="sm" variant="outline" onClick={() => setOffsetWeeks(0)}>Today</Button>
            <Button size="sm" variant="outline" onClick={() => setOffsetWeeks((w) => w + 8)}>Later</Button>
          </div>
        </CardHeader>
        <CardContent>
          {inventory.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : inventory.error ? (
            <p className="text-sm text-destructive">{inventory.error.message}</p>
          ) : (inventory.data?.issues ?? []).length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
              <CalendarDays className="h-8 w-8 mb-3 text-primary" />
              Nothing scheduled in this window. Add a publication, then its upcoming issues or episodes with their slots.
            </div>
          ) : (
            <div className="space-y-3">
              {(inventory.data?.issues ?? []).map((issue) => (
                <div key={issue.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-medium">{issue.publishOn}</span>{" "}
                      <span className="text-sm">{issue.publicationName} — {issue.title}</span>
                    </div>
                    {issue.status !== "scheduled" && <Badge variant="secondary">{issue.status}</Badge>}
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {issue.slots.map((slot) => (
                      <div key={slot.id} className={`rounded border p-2 text-sm ${slot.booking ? "bg-muted" : ""}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{slot.label}</span>
                          <span className="text-xs text-muted-foreground">{SLOT_FORMAT_LABELS[slot.format]}</span>
                        </div>
                        {slot.booking ? (
                          <div className="mt-1 text-xs">
                            <Link className="underline" href={`/orgs/${orgSlug}/deals/${slot.booking.dealId}`}>
                              {slot.booking.sponsorName} — {slot.booking.dealTitle}
                            </Link>{" "}
                            <StageBadge stage={slot.booking.dealStage} /> · {money(slot.booking.priceCents, slot.booking.currency)}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-muted-foreground">Open · list {money(slot.listPriceCents, slot.currency)}</div>
                        )}
                      </div>
                    ))}
                    {issue.slots.length === 0 && <p className="text-xs text-muted-foreground">No slots on this issue.</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PublicationForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({ name: "", kind: "newsletter" as PublicationKind, niche: "tech" as Niche, audience: "" });
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const audienceSize = Number(form.audience.replace(/[,\s]/g, ""));
    if (!Number.isInteger(audienceSize) || audienceSize < 0) {
      toast({ kind: "error", title: "Audience size must be a whole number" });
      return;
    }
    setBusy(true);
    const r = await wrap(async () => client.deals.createPublication(orgId, { name: form.name, kind: form.kind, niche: form.niche, audienceSize }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not add the publication", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `${form.name} added` });
    onDone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New publication</CardTitle>
        <CardDescription>A newsletter or a podcast you sell sponsorships in. Audience size is subscribers, or downloads per episode.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="p-name">Name</label>
            <Input id="p-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </div>
          <div>
            <label className={labelClass} htmlFor="p-kind">Kind</label>
            <select id="p-kind" className={selectClass} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as PublicationKind }))}>
              <option value="newsletter">Newsletter</option>
              <option value="podcast">Podcast</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="p-niche">Niche</label>
            <select id="p-niche" className={selectClass} value={form.niche} onChange={(e) => setForm((f) => ({ ...f, niche: e.target.value as Niche }))}>
              {NICHES.map((n) => (
                <option key={n} value={n}>{NICHE_LABELS[n]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="p-audience">Audience size</label>
            <Input id="p-audience" inputMode="numeric" value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))} required />
          </div>
          <div className="mt-5 flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Add publication"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const DEFAULT_SLOTS: Record<PublicationKind, { label: string; format: SlotFormat }[]> = {
  newsletter: [
    { label: "Primary", format: "nl_primary" },
    { label: "Secondary", format: "nl_secondary" },
  ],
  podcast: [
    { label: "Pre-roll", format: "pod_preroll" },
    { label: "Mid-roll", format: "pod_midroll" },
  ],
};

function IssueForm({
  orgId,
  publications,
  onDone,
  onCancel,
}: {
  orgId: string;
  publications: PublicPublication[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [pubId, setPubId] = React.useState(publications[0]?.id ?? "");
  const pub = publications.find((p) => p.id === pubId);
  const [title, setTitle] = React.useState("");
  const [publishOn, setPublishOn] = React.useState("");
  const [prices, setPrices] = React.useState<string[]>(["", ""]);
  const [busy, setBusy] = React.useState(false);
  const slots = pub ? DEFAULT_SLOTS[pub.kind] : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cents = prices.map(toCents);
    if (cents.some((c) => Number.isNaN(c))) {
      toast({ kind: "error", title: "A price is not a number" });
      return;
    }
    setBusy(true);
    const r = await wrap(async () =>
      client.deals.createIssue(orgId, pubId, {
        title,
        publishOn,
        slots: slots.map((s, i) => ({ ...s, listPriceCents: cents[i] ?? null })),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not add the issue", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `${title} scheduled for ${publishOn}` });
    onDone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New issue or episode</CardTitle>
        <CardDescription>Created with its two standard slots. Set a list price on each, or leave it blank and price per deal.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="i-pub">Publication</label>
            <select id="i-pub" className={selectClass} value={pubId} onChange={(e) => setPubId(e.target.value)}>
              {publications.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="i-title">Title</label>
            <Input id="i-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Issue #142" required />
          </div>
          <div>
            <label className={labelClass} htmlFor="i-date">Publishes on</label>
            <Input id="i-date" type="date" value={publishOn} onChange={(e) => setPublishOn(e.target.value)} required />
          </div>
          {slots.map((s, i) => (
            <div key={s.label}>
              <label className={labelClass} htmlFor={`i-price-${i}`}>{s.label} list price</label>
              <Input
                id={`i-price-${i}`}
                inputMode="decimal"
                value={prices[i] ?? ""}
                onChange={(e) => setPrices((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
              />
            </div>
          ))}
          <div className="mt-5 flex gap-2 sm:col-span-3">
            <Button type="submit" disabled={busy || !pubId}>{busy ? "Saving…" : "Add issue"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
