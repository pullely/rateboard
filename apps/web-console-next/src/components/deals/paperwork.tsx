"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { labelClass, money, toCents } from "@/components/deals/format";
import type { GetDealResponse, PublicBooking } from "@saas/contracts/deal";

const ISSUABLE = ["booked", "delivered", "paid"];

/** RB2: the deal's insertion order — draw up, edit, send to the sponsor, record the signature. */
export function InsertionOrderPanel({ orgId, dealId, data, reload }: { orgId: string; dealId: string; data: GetDealResponse; reload: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const io = data.insertionOrder;
  const [terms, setTerms] = React.useState(io?.terms ?? "");
  const [total, setTotal] = React.useState(io ? (io.totalCents / 100).toFixed(2) : "");
  const [due, setDue] = React.useState(io?.paymentDueOn ?? "");
  const [busy, setBusy] = React.useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    const r = await wrap(fn);
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: `Could not ${label}`, description: r.error.message });
      return;
    }
    toast({ kind: "success", title: label.charAt(0).toUpperCase() + label.slice(1) });
    reload();
  }

  function fields() {
    const cents = toCents(total);
    return {
      terms,
      ...(cents !== null && !Number.isNaN(cents) ? { totalCents: cents } : {}),
      paymentDueOn: due || null,
    };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Insertion order {io ? <span className="font-mono">{io.number}</span> : null}{" "}
          {io ? <Badge variant={io.status === "signed" ? "success" : io.status === "sent" ? "default" : "secondary"}>{io.status}</Badge> : null}
        </CardTitle>
        <CardDescription>
          Numbered per organization. &ldquo;Send&rdquo; emails it to the sponsor contact; the signature is recorded by hand.
          {io?.sentAt ? ` Last sent ${io.sentAt.slice(0, 16).replace("T", " ")} to ${io.sentTo} (accepted for delivery).` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!ISSUABLE.includes(data.deal.stage) && !io ? (
          <p className="text-sm text-muted-foreground">Mark the deal booked to draw up its insertion order.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className={labelClass} htmlFor="io-total">Total ({data.deal.currency}){io ? "" : " — blank = sum of bookings"}</label>
                <Input id="io-total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} disabled={io?.status === "signed"} />
              </div>
              <div>
                <label className={labelClass} htmlFor="io-due">Payment due</label>
                <Input id="io-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={io?.status === "signed"} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor="io-terms">Terms</label>
              <textarea
                id="io-terms"
                className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                disabled={io?.status === "signed"}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {!io ? (
                <Button size="sm" disabled={busy} onClick={() => void run("draw up the insertion order", () => client.deals.createInsertionOrder(orgId, dealId, fields()))}>
                  Draw up IO
                </Button>
              ) : io.status !== "signed" ? (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("save the insertion order", () => client.deals.updateInsertionOrder(orgId, dealId, fields()))}>
                    Save
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void run("send the insertion order", () => client.deals.sendInsertionOrder(orgId, dealId))}>
                    {io.sendCount > 0 ? "Send again" : "Send to sponsor"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("record the signature", () => client.deals.updateInsertionOrder(orgId, dealId, { status: "signed" }))}>
                    Mark signed
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Signed {io.signedAt?.slice(0, 10)} · {money(io.totalCents, io.currency)}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** RB2: record the proof of delivery for one live booking. */
export function DeliveryForm({ orgId, dealId, booking, onSaved }: { orgId: string; dealId: string; booking: PublicBooking; onSaved: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const d = booking.delivery;
  const [open, setOpen] = React.useState(false);
  const [deliveredOn, setDeliveredOn] = React.useState(d?.deliveredOn ?? booking.publishOn);
  const [proofUrl, setProofUrl] = React.useState(d?.proofUrl ?? "");
  const [opens, setOpens] = React.useState(d?.opens?.toString() ?? "");
  const [clicks, setClicks] = React.useState(d?.clicks?.toString() ?? "");
  const [downloads, setDownloads] = React.useState(d?.downloads?.toString() ?? "");
  const [impressions, setImpressions] = React.useState(d?.impressions?.toString() ?? "");
  const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[,\s]/g, "")));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await wrap(async () =>
      client.deals.putDelivery(orgId, dealId, booking.id, {
        deliveredOn,
        proofUrl: proofUrl || null,
        opens: n(opens),
        clicks: n(clicks),
        downloads: n(downloads),
        impressions: n(impressions),
      }),
    );
    if (!r.ok) {
      toast({ kind: "error", title: "Could not record the delivery", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Delivery recorded for ${booking.slotLabel}` });
    setOpen(false);
    onSaved();
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {d ? `Delivered ${d.deliveredOn}` : "Record delivery"}
      </Button>
    );
  }
  return (
    <form onSubmit={save} className="grid gap-2 text-left sm:grid-cols-3">
      <Input aria-label="Delivered on" type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} required />
      <Input aria-label="Proof URL" placeholder="https://… (the live issue)" value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} className="sm:col-span-2" />
      <Input aria-label="Opens" placeholder="Opens" inputMode="numeric" value={opens} onChange={(e) => setOpens(e.target.value)} />
      <Input aria-label="Clicks" placeholder="Clicks" inputMode="numeric" value={clicks} onChange={(e) => setClicks(e.target.value)} />
      <Input aria-label="Downloads" placeholder="Downloads" inputMode="numeric" value={downloads} onChange={(e) => setDownloads(e.target.value)} />
      <Input aria-label="Impressions" placeholder="Impressions" inputMode="numeric" value={impressions} onChange={(e) => setImpressions(e.target.value)} />
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm">Save delivery</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** RB2: the sponsor's no-login report link — create (token shown once), revoke. */
export function ReportLinksPanel({ orgId, dealId, data, reload }: { orgId: string; dealId: string; data: GetDealResponse; reload: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [fresh, setFresh] = React.useState<string | null>(null);
  const live = data.reportLinks.find((l) => l.live);

  async function create() {
    const r = await wrap(async () => client.deals.createReportLink(orgId, dealId, { expiresInDays: 90 }));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not create the link", description: r.error.message });
      return;
    }
    const url = typeof window !== "undefined" ? `${window.location.origin}/r/${r.data.token}` : `/r/${r.data.token}`;
    setFresh(url);
    reload();
  }

  async function revoke(id: string) {
    const r = await wrap(async () => client.deals.revokeReportLink(orgId, dealId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not revoke the link", description: r.error.message });
      return;
    }
    setFresh(null);
    toast({ kind: "success", title: "Link revoked — it now answers “not found”" });
    reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sponsor report link</CardTitle>
        <CardDescription>
          A no-login page with each delivered slot&rsquo;s date, proof and stats — never prices or notes. One live link per deal; revoke it any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {fresh ? (
          <div className="rounded-md border p-2">
            <div className="text-xs text-muted-foreground">Copy it now — it is shown only once.</div>
            <div className="break-all font-mono text-xs">{fresh}</div>
          </div>
        ) : null}
        {live ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Live since {live.createdAt.slice(0, 10)}
              {live.expiresAt ? ` · expires ${live.expiresAt.slice(0, 10)}` : ""} · viewed {live.viewCount}×
            </span>
            <Button size="sm" variant="outline" onClick={() => void revoke(live.id)}>Revoke</Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => void create()}>Create report link</Button>
        )}
      </CardContent>
    </Card>
  );
}
