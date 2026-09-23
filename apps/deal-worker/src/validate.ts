import {
  DEAL_PRICING,
  DEAL_STAGES,
  ISSUE_MAX_INLINE_SLOTS,
  NICHES,
  PLATFORMS,
  PUBLICATION_KINDS,
  PUBLICATION_STATUSES,
  SLOT_FORMATS,
  type DealPricing,
  type DealStage,
  type Niche,
  type Platform,
  type PublicationKind,
  type PublicationStatus,
  type SlotFormat,
} from "@saas/contracts/deal";
import type { DealFields, Publication, PublicationFields, Sponsor, SponsorFields, Deal } from "@saas/db/deal";

export type Validation<T> = { valid: true; value: T } | { valid: false; fields: Record<string, string[]> };

// No ':' anywhere: an address may become part of a notification idempotency key (RB2).
const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const MAX_CENTS = 100_000_000_000; // one billion in major units
const MAX_AUDIENCE = 100_000_000;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

class Collector {
  fields: Record<string, string[]> = {};
  add(field: string, message: string): void {
    (this.fields[field] ??= []).push(message);
  }
  get ok(): boolean {
    return Object.keys(this.fields).length === 0;
  }
}

/** undefined = absent; null = explicitly cleared; string = the trimmed value. */
function text(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; max: number },
): string | null | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null || v === "") {
    if (opts.required) c.add(field, "Required");
    return null;
  }
  if (typeof v !== "string") {
    c.add(field, "Must be a string");
    return undefined;
  }
  const trimmed = v.trim();
  if (opts.required && trimmed.length === 0) c.add(field, "Required");
  if (trimmed.length > opts.max) c.add(field, `At most ${opts.max} characters`);
  return trimmed.length === 0 ? null : trimmed;
}

function email(c: Collector, body: Record<string, unknown>, field: string): string | null | undefined {
  const v = text(c, body, field, { required: false, max: 254 });
  if (typeof v === "string" && !EMAIL_RE.test(v)) c.add(field, "Not an email address");
  return typeof v === "string" ? v.toLowerCase() : v;
}

function url(c: Collector, body: Record<string, unknown>, field: string): string | null | undefined {
  const v = text(c, body, field, { required: false, max: 500 });
  if (typeof v === "string" && !URL_RE.test(v)) c.add(field, "An http(s) URL");
  return v;
}

function date(c: Collector, body: Record<string, unknown>, field: string, required: boolean): string | null | undefined {
  const v = text(c, body, field, { required, max: 10 });
  if (typeof v === "string" && !isCalendarDate(v)) c.add(field, "A date as YYYY-MM-DD");
  return v;
}

function oneOf<T extends string>(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  opts: { required: boolean; nullable?: boolean },
): T | null | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null && opts.nullable) return null;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    c.add(field, `One of ${allowed.join(", ")}`);
    return undefined;
  }
  return v as T;
}

function int(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; nullable: boolean; max: number; message: string },
): number | null | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null) {
    if (!opts.nullable) c.add(field, "Required");
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > opts.max) {
    c.add(field, opts.message);
    return undefined;
  }
  return v;
}

function currency(c: Collector, body: Record<string, unknown>, field = "currency"): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  const v = body[field];
  if (typeof v !== "string" || !CURRENCY_RE.test(v)) {
    c.add(field, "A three-letter ISO 4217 code, e.g. USD");
    return undefined;
  }
  return v;
}

const CENTS = { max: MAX_CENTS, message: "A whole number of minor units (cents), 0 or more" };

// ── publications ───────────────────────────────────────────

export function validatePublicationBody(body: unknown, current: Publication | null): Validation<PublicationFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const creating = current === null;
  const name = text(c, body, "name", { required: creating, max: 120 });
  if (!creating && name === null) c.add("name", "Required");
  const kind = oneOf<PublicationKind>(c, body, "kind", PUBLICATION_KINDS, { required: creating });
  const niche = oneOf<Niche>(c, body, "niche", NICHES, { required: creating });
  const audienceSize = int(c, body, "audienceSize", {
    required: creating,
    nullable: false,
    max: MAX_AUDIENCE,
    message: `A whole number from 0 to ${MAX_AUDIENCE}`,
  });
  const platform = oneOf<Platform>(c, body, "platform", PLATFORMS, { required: false, nullable: true });
  const cur = currency(c, body);
  const status = oneOf<PublicationStatus>(c, body, "status", PUBLICATION_STATUSES, { required: false });
  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: {
      name: name ?? current?.name ?? "",
      kind: kind ?? current?.kind ?? "newsletter",
      niche: niche ?? current?.niche ?? "other",
      audienceSize: audienceSize ?? current?.audienceSize ?? 0,
      platform: platform === undefined ? (current?.platform ?? null) : platform,
      currency: cur ?? current?.currency ?? "USD",
      status: status ?? current?.status ?? "active",
    },
  };
}

// ── issues and slots ───────────────────────────────────────

export interface SlotInput {
  label: string;
  format: SlotFormat;
  listPriceCents: number | null;
  currency: string | undefined;
}

function slotFrom(c: Collector, body: Record<string, unknown>, prefix: string): SlotInput | null {
  const inner = new Collector();
  const label = text(inner, body, "label", { required: true, max: 60 });
  const format = oneOf<SlotFormat>(inner, body, "format", SLOT_FORMATS, { required: true });
  const listPriceCents = int(inner, body, "listPriceCents", { required: false, nullable: true, ...CENTS });
  const cur = currency(inner, body);
  for (const [f, msgs] of Object.entries(inner.fields)) for (const m of msgs) c.add(`${prefix}${f}`, m);
  if (!inner.ok) return null;
  return { label: label!, format: format!, listPriceCents: listPriceCents ?? null, currency: cur };
}

export function validateSlotBody(body: unknown): Validation<SlotInput> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const slot = slotFrom(c, body, "");
  if (!c.ok || !slot) return { valid: false, fields: c.fields };
  return { valid: true, value: slot };
}

export interface IssueInput {
  title: string;
  publishOn: string;
  slots: SlotInput[];
}

export function validateIssueBody(body: unknown): Validation<IssueInput> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const title = text(c, body, "title", { required: true, max: 120 });
  const publishOn = date(c, body, "publishOn", true);
  const slots: SlotInput[] = [];
  if ("slots" in body && body.slots !== undefined && body.slots !== null) {
    if (!Array.isArray(body.slots)) c.add("slots", "Must be an array");
    else if (body.slots.length > ISSUE_MAX_INLINE_SLOTS) c.add("slots", `At most ${ISSUE_MAX_INLINE_SLOTS} slots`);
    else {
      const seen = new Set<string>();
      body.slots.forEach((raw, i) => {
        if (!isObject(raw)) {
          c.add(`slots.${i}`, "Must be an object");
          return;
        }
        const slot = slotFrom(c, raw, `slots.${i}.`);
        if (!slot) return;
        const key = slot.label.toLowerCase();
        if (seen.has(key)) c.add(`slots.${i}.label`, "Duplicate label in this issue");
        seen.add(key);
        slots.push(slot);
      });
    }
  }
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { title: title!, publishOn: publishOn!, slots } };
}

// ── sponsors ───────────────────────────────────────────────

export function validateSponsorBody(body: unknown, current: Sponsor | null): Validation<SponsorFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const creating = current === null;
  const name = text(c, body, "name", { required: creating, max: 120 });
  if (!creating && name === null) c.add("name", "Required");
  const website = url(c, body, "website");
  const contactName = text(c, body, "contactName", { required: false, max: 120 });
  const contactEmail = email(c, body, "contactEmail");
  const notes = text(c, body, "notes", { required: false, max: 5000 });
  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: {
      name: name ?? current?.name ?? "",
      website: website === undefined ? (current?.website ?? null) : website,
      contactName: contactName === undefined ? (current?.contactName ?? null) : contactName,
      contactEmail: contactEmail === undefined ? (current?.contactEmail ?? null) : contactEmail,
      notes: notes === undefined ? (current?.notes ?? "") : (notes ?? ""),
    },
  };
}

// ── deals ──────────────────────────────────────────────────

export interface DealCreateInput extends DealFields {
  sponsorId: string | null;
  sponsorName: string | null;
}

function dealFields(c: Collector, body: Record<string, unknown>, current: Deal | null): DealFields {
  const creating = current === null;
  const title = text(c, body, "title", { required: creating, max: 200 });
  if (!creating && title === null) c.add("title", "Required");
  const valueCents = int(c, body, "valueCents", { required: false, nullable: true, ...CENTS });
  const cur = currency(c, body);
  const pricing = oneOf<DealPricing>(c, body, "pricing", DEAL_PRICING, { required: false });
  const cpmCents = int(c, body, "cpmCents", { required: false, nullable: true, ...CENTS });
  const notes = text(c, body, "notes", { required: false, max: 10_000 });
  const merged: DealFields = {
    title: title ?? current?.title ?? "",
    valueCents: valueCents === undefined ? (current?.valueCents ?? null) : valueCents,
    currency: cur ?? current?.currency ?? "USD",
    pricing: pricing ?? current?.pricing ?? "flat",
    cpmCents: cpmCents === undefined ? (current?.cpmCents ?? null) : cpmCents,
    notes: notes === undefined ? (current?.notes ?? "") : (notes ?? ""),
  };
  if (merged.pricing === "cpm" && merged.cpmCents === null) c.add("cpmCents", "Required when pricing is cpm");
  return merged;
}

export function validateDealCreate(body: unknown): Validation<DealCreateInput> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const fields = dealFields(c, body, null);
  const sponsorId = text(c, body, "sponsorId", { required: false, max: 40 });
  const sponsorName = text(c, body, "sponsorName", { required: false, max: 120 });
  if (!sponsorId && !sponsorName) c.add("sponsorId", "Give sponsorId or sponsorName");
  if (sponsorId && sponsorName) c.add("sponsorName", "Give sponsorId or sponsorName, not both");
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { ...fields, sponsorId: sponsorId ?? null, sponsorName: sponsorName ?? null } };
}

export function validateDealPatch(body: unknown, current: Deal): Validation<DealFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  for (const f of ["stage", "sponsorId", "sponsorName"]) {
    if (f in body) c.add(f, f === "stage" ? "Use POST …/stage to move a deal" : "A deal's sponsor cannot be changed");
  }
  const fields = dealFields(c, body, current);
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: fields };
}

export function validateStageMove(body: unknown): Validation<{ to: DealStage; from: DealStage | undefined }> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const to = oneOf<DealStage>(c, body, "to", DEAL_STAGES, { required: true });
  const from = oneOf<DealStage>(c, body, "from", DEAL_STAGES, { required: false });
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { to: to!, from: from ?? undefined } };
}

export function validateBookingBody(body: unknown): Validation<{ slotId: string; priceCents: number | null }> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const slotId = text(c, body, "slotId", { required: true, max: 40 });
  const priceCents = int(c, body, "priceCents", { required: false, nullable: true, ...CENTS });
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { slotId: slotId!, priceCents: priceCents ?? null } };
}

export function validateRange(from: string | null, to: string | null): Validation<{ from: string | null; to: string | null }> {
  const c = new Collector();
  if (from !== null && !isCalendarDate(from)) c.add("from", "A date as YYYY-MM-DD");
  if (to !== null && !isCalendarDate(to)) c.add("to", "A date as YYYY-MM-DD");
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { from, to } };
}
