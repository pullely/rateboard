/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { route } from "@deal-worker/router";
import { orgPublicId } from "@deal-worker/ids";
import { ORG_A, ORG_B, OWNER, as, json, type TestWorld } from "./harness";

export const ORG = orgPublicId(ORG_A);
export const OTHER_ORG = orgPublicId(ORG_B);
const BASE = "https://deal.internal";

export function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

export function get(w: TestWorld, path: string, who: string): Promise<Response> {
  return call(w, path, { headers: as(who) });
}

export function send(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, {
    method,
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function ok(res: Response, status = 200): Promise<Record<string, any>> {
  const body = await json(res);
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  return body.data;
}

/** A newsletter with one issue holding a primary and a secondary slot, and a deal with a new sponsor. */
export async function seed(
  w: TestWorld,
  opts: { org?: string; who?: string; publishOn?: string; sponsorName?: string; dealTitle?: string } = {},
): Promise<{ publication: any; issue: any; primary: any; secondary: any; deal: any }> {
  const org = opts.org ?? ORG;
  const who = opts.who ?? OWNER;
  const { publication } = await ok(
    await send(w, `/v1/organizations/${org}/publications`, who, {
      name: "The Stack Weekly",
      kind: "newsletter",
      niche: "tech",
      audienceSize: 24_000,
      platform: "beehiiv",
    }),
    201,
  );
  const { issue } = await ok(
    await send(w, `/v1/organizations/${org}/publications/${publication.id}/issues`, who, {
      title: "Issue #142",
      publishOn: opts.publishOn ?? "2026-10-06",
      slots: [
        { label: "Primary", format: "nl_primary", listPriceCents: 120_000 },
        { label: "Secondary", format: "nl_secondary", listPriceCents: 45_000 },
      ],
    }),
    201,
  );
  const { deal } = await ok(
    await send(w, `/v1/organizations/${org}/deals`, who, {
      sponsorName: opts.sponsorName ?? "Acme Analytics",
      title: opts.dealTitle ?? "Q4 launch",
      valueCents: 120_000,
    }),
    201,
  );
  return { publication, issue, primary: issue.slots[0], secondary: issue.slots[1], deal };
}

export async function newDeal(w: TestWorld, title: string, sponsorName = "Globex", org = ORG, who = OWNER): Promise<any> {
  return (await ok(await send(w, `/v1/organizations/${org}/deals`, who, { sponsorName, title }), 201)).deal;
}

export function book(w: TestWorld, dealId: string, slotId: string, who = OWNER, org = ORG): Promise<Response> {
  return send(w, `/v1/organizations/${org}/deals/${dealId}/bookings`, who, { slotId });
}

export function move(w: TestWorld, dealId: string, to: string, who = OWNER, from?: string): Promise<Response> {
  return send(w, `/v1/organizations/${ORG}/deals/${dealId}/stage`, who, from ? { to, from } : { to });
}

export function auditTypes(w: TestWorld): string[] {
  return (w.db.prepare("SELECT event_type FROM events_audit_entries ORDER BY occurred_at, rowid").all() as { event_type: string }[]).map(
    (r) => r.event_type,
  );
}
