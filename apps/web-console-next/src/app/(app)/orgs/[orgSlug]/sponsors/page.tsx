"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Handshake } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { labelClass } from "@/components/deals/format";

export default function SponsorsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const sponsors = useApiQuery(qk.sponsors(orgId), () => wrap(async () => (await client.deals.listSponsors(orgId)).sponsors));
  const [form, setForm] = React.useState({ name: "", website: "", contactName: "", contactEmail: "" });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await wrap(async () =>
      client.deals.createSponsor(orgId, {
        name: form.name,
        website: form.website || null,
        contactName: form.contactName || null,
        contactEmail: form.contactEmail || null,
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not add the sponsor", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `${form.name} added` });
    setForm({ name: "", website: "", contactName: "", contactEmail: "" });
    sponsors.reload();
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Sponsors</h1>
        <p className="text-sm text-muted-foreground">The companies you sell to, and who to talk to there.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a sponsor</CardTitle>
          <CardDescription>A new deal can also create its sponsor by name.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="s-name">Company</label>
              <Input id="s-name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </div>
            <div>
              <label className={labelClass} htmlFor="s-web">Website</label>
              <Input id="s-web" type="url" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
            </div>
            <div>
              <label className={labelClass} htmlFor="s-contact">Contact</label>
              <Input id="s-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
            </div>
            <div>
              <label className={labelClass} htmlFor="s-email">Contact email</label>
              <Input id="s-email" type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
            </div>
            <div className="mt-5 sm:col-span-2">
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Add sponsor"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {sponsors.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : sponsors.error ? (
            <p className="text-sm text-destructive">{sponsors.error.message}</p>
          ) : (sponsors.data ?? []).length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center text-sm text-muted-foreground">
              <Handshake className="h-8 w-8 mb-3 text-primary" />
              No sponsors yet.
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Contact</TH>
                  <TH>Added</TH>
                </TR>
              </THead>
              <TBody>
                {(sponsors.data ?? []).map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <div className="font-medium">{s.name}</div>
                      {s.website && <div className="text-xs text-muted-foreground">{s.website}</div>}
                    </TD>
                    <TD className="text-sm">
                      {s.contactName ?? "—"}
                      {s.contactEmail && <div className="text-xs text-muted-foreground">{s.contactEmail}</div>}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{s.createdAt.slice(0, 10)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
