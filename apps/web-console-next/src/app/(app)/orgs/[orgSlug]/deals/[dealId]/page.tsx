"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { StageBadge, labelClass, money, selectClass, toCents } from "@/components/deals/format";
import {
  DEAL_STAGE_LABELS,
  SLOT_FORMAT_LABELS,
  type DealStage,
  type GetDealResponse,
  type PublicBooking,
} from "@saas/contracts/deal";

export default function DealPage() {
  const params = useParams<{ orgSlug: string; dealId: string }>();
  const slug = params?.orgSlug ?? "";
  const dealId = params?.dealId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} dealId={dealId} />}</OrgScope>;
}

function Inner({ orgId, orgSlug, dealId }: { orgId: string; orgSlug: string; dealId: string }) {
  const { client } = useSession();
  const detail = useApiQuery(qk.deal(orgId, dealId), () => wrap(async () => client.deals.getDeal(orgId, dealId)));
  if (detail.loading) return <Skeleton className="h-40 w-full" />;
  if (detail.error || !detail.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{detail.error?.code ?? "not_found"}</CardTitle>
          <CardDescription>{detail.error?.message ?? "Deal not found"}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <Detail orgId={orgId} orgSlug={orgSlug} dealId={dealId} data={detail.data} reload={detail.reload} />;
}

function Detail({
  orgId,
  orgSlug,
  dealId,
  data,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  dealId: string;
  data: GetDealResponse;
  reload: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const { deal, bookings, history } = data;
  const live = bookings.filter((b) => b.releasedAt === null);
  const [busy, setBusy] = React.useState(false);

  async function moveTo(to: DealStage) {
    setBusy(true);
    const r = await wrap(async () => client.deals.moveStage(orgId, dealId, { to, from: deal.stage }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: `Could not move to ${DEAL_STAGE_LABELS[to]}`, description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Moved to ${DEAL_STAGE_LABELS[to]}` });
    reload();
  }

  async function release(b: PublicBooking) {
    const r = await wrap(async () => client.deals.release(orgId, dealId, b.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not release the slot", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Released ${b.slotLabel} in ${b.issueTitle}` });
    reload();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link className="underline" href={`/orgs/${orgSlug}/pipeline`}>Pipeline</Link> · {deal.sponsorName}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{deal.title}</h1>
          <p className="text-sm text-muted-foreground">
            <StageBadge stage={deal.stage} /> · {money(deal.valueCents, deal.currency)}
            {deal.pricing === "cpm" ? ` · CPM ${money(deal.cpmCents, deal.currency)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {deal.nextStages.map((to) => (
            <Button key={to} size="sm" variant={to === "lost" ? "outline" : "default"} disabled={busy} onClick={() => void moveTo(to)}>
              {to === "lead" ? "Reopen" : `Mark ${DEAL_STAGE_LABELS[to].toLowerCase()}`}
            </Button>
          ))}
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Booked slots</CardTitle>
          <CardDescription>
            A slot holds one sponsor. Booking a slot another deal holds is refused, whoever tries first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {bookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No slots booked yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Slot</TH>
                  <TH>Price</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {bookings.map((b) => (
                  <TR key={b.id}>
                    <TD className="whitespace-nowrap text-sm">{b.publishOn}</TD>
                    <TD>
                      <div className="font-medium">{b.publicationName} — {b.issueTitle}</div>
                      <div className="text-xs text-muted-foreground">{b.slotLabel} · {SLOT_FORMAT_LABELS[b.format]}</div>
                    </TD>
                    <TD className="text-sm">{money(b.priceCents, b.currency)}</TD>
                    <TD className="text-right">
                      {b.releasedAt ? (
                        <Badge variant="secondary">{b.releaseReason === "deal_lost" ? "Released (lost)" : "Released"}</Badge>
                      ) : ["lead", "pitched", "booked"].includes(deal.stage) ? (
                        <Button size="sm" variant="ghost" onClick={() => void release(b)}>Release</Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {["lead", "pitched", "booked"].includes(deal.stage) && (
            <BookSlot orgId={orgId} dealId={dealId} liveCount={live.length} onBooked={reload} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1 text-sm">
            {history.map((h, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{h.changedAt.slice(0, 16).replace("T", " ")}</span> ·{" "}
                {h.fromStage ? `${DEAL_STAGE_LABELS[h.fromStage]} → ` : "Created as "}
                {DEAL_STAGE_LABELS[h.toStage]}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function BookSlot({ orgId, dealId, liveCount, onBooked }: { orgId: string; dealId: string; liveCount: number; onBooked: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const inventory = useApiQuery(qk.inventory(orgId, `${from}:${to}`), () => wrap(async () => client.deals.inventory(orgId, { from, to })));
  const [slotId, setSlotId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const open = (inventory.data?.issues ?? []).flatMap((i) =>
    i.slots.filter((s) => s.booking === null && i.status !== "cancelled").map((s) => ({ issue: i, slot: s })),
  );

  async function book(e: React.FormEvent) {
    e.preventDefault();
    const priceCents = toCents(price);
    if (Number.isNaN(priceCents)) {
      toast({ kind: "error", title: "The price is not a number" });
      return;
    }
    setBusy(true);
    const r = await wrap(async () => client.deals.book(orgId, dealId, { slotId, ...(priceCents !== null ? { priceCents } : {}) }));
    setBusy(false);
    if (!r.ok) {
      // A 409 here is the database refusing a double-booking: someone got there first.
      toast({ kind: "error", title: "Could not book the slot", description: r.error.message });
      inventory.reload();
      return;
    }
    toast({ kind: "success", title: "Slot booked" });
    setSlotId("");
    setPrice("");
    inventory.reload();
    onBooked();
  }

  return (
    <form onSubmit={book} className="grid gap-3 sm:grid-cols-4 sm:items-end">
      <div className="sm:col-span-2">
        <label className={labelClass} htmlFor="b-slot">
          Book an open slot (next 90 days){liveCount > 0 ? ` · ${liveCount} held` : ""}
        </label>
        <select id="b-slot" className={selectClass} value={slotId} onChange={(e) => setSlotId(e.target.value)} required>
          <option value="">{inventory.loading ? "Loading…" : open.length ? "Choose a slot…" : "No open slots — add issues on Inventory"}</option>
          {open.map(({ issue, slot }) => (
            <option key={slot.id} value={slot.id}>
              {issue.publishOn} · {issue.publicationName} {issue.title} · {slot.label} ({money(slot.listPriceCents, slot.currency)})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor="b-price">Price (blank = list)</label>
        <Input id="b-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
      <Button type="submit" disabled={busy || !slotId}>{busy ? "Booking…" : "Book slot"}</Button>
    </form>
  );
}
