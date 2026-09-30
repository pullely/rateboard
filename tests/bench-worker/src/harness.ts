/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import { createBenchRepository } from "@saas/db/bench";
import { createSqlExecutor } from "@saas/db/d1";
import type { Env } from "@bench-worker/env";
import { route } from "@bench-worker/router";
import { runAggregate } from "@bench-worker/run";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT).filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql"))).sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

export function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true, meta: {} });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

let seq = 0;
/** A fresh UUID-shaped id with a readable counter. */
export function uuid(): string {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export function orgPublic(uuidStr: string): string {
  return `org_${uuidStr.replace(/-/g, "")}`;
}

export function usrPublic(uuidStr: string): string {
  return `usr_${uuidStr.replace(/-/g, "")}`;
}

// role per (subject, org), for the membership/policy stand-ins
const ROLE_ACTIONS: Record<string, ReadonlySet<string>> = {
  owner: new Set(["bench.contribute", "bench.read"]),
  admin: new Set(["bench.contribute", "bench.read"]),
  builder: new Set(["bench.read"]),
  viewer: new Set(["bench.read"]),
};

export interface World {
  db: DatabaseSync;
  env: Env;
  roles: Map<string, Map<string, string>>;
}

export function world(): World {
  const db = migratedDatabase();
  const roles = new Map<string, Map<string, string>>();
  const membership = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string }; orgId: string };
      const role = roles.get(body.subject.id)?.get(body.orgId) ?? null;
      return Response.json({ data: { memberships: role ? [{ kind: "organization", orgId: body.orgId, role }] : [] } });
    },
  };
  const policy = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { action: string; resource: { orgId: string }; context: { memberships: { orgId: string; role: string }[] } };
      const role = body.context.memberships.find((m) => m.orgId === body.resource.orgId)?.role;
      return Response.json({ data: { allow: role !== undefined && (ROLE_ACTIONS[role]?.has(body.action) ?? false) } });
    },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db),
    MEMBERSHIP_WORKER: membership as unknown as Fetcher,
    POLICY_WORKER: policy as unknown as Fetcher,
  } as Env;
  return { db, env, roles };
}

/** Grant `subject` a role in `org`, both in the stand-ins and in the membership tables the aggregate reads. */
export function grant(w: World, org: string, subject: string, role: "owner" | "admin" | "builder" | "viewer"): void {
  const byOrg = w.roles.get(subject) ?? new Map<string, string>();
  byOrg.set(org, role);
  w.roles.set(subject, byOrg);
  w.db
    .prepare("INSERT OR IGNORE INTO membership_organization_members (id, org_id, subject_id, subject_type, status) VALUES (?, ?, ?, 'user', 'active')")
    .run(uuid(), org, subject);
  w.db
    .prepare("INSERT INTO membership_role_assignments (id, org_id, subject_id, subject_type, role, scope_kind) VALUES (?, ?, ?, 'user', ?, 'organization')")
    .run(uuid(), org, subject, role);
}

export interface BookingSpec {
  niche?: string | undefined;
  audience?: number | undefined;
  format?: string | undefined;
  price: number;
  currency?: string;
  stage?: string;
  bookedAt?: string;
}

/** Insert one live booking (and the publication, issue, slot, sponsor and deal it needs) for an org. */
export function addBooking(w: World, org: string, b: BookingSpec): string {
  const niche = b.niche ?? "tech";
  const audience = b.audience ?? 24_000;
  const format = b.format ?? "nl_primary";
  const pub = uuid();
  const issue = uuid();
  const slot = uuid();
  const sponsor = uuid();
  const deal = uuid();
  const booking = uuid();
  const now = b.bookedAt ?? "2026-09-01T00:00:00.000Z";
  w.db
    .prepare("INSERT INTO deal_publications (id, org_id, name, kind, niche, audience_size) VALUES (?, ?, ?, ?, ?, ?)")
    .run(pub, org, `Pub ${pub}`, format.startsWith("pod_") ? "podcast" : "newsletter", niche, audience);
  w.db.prepare("INSERT INTO deal_issues (id, org_id, publication_id, title, publish_on) VALUES (?, ?, ?, ?, '2026-10-06')").run(issue, org, pub, `Issue ${issue}`);
  w.db
    .prepare("INSERT INTO deal_slots (id, org_id, issue_id, publication_id, label, format, list_price_cents) VALUES (?, ?, ?, ?, 'Primary', ?, ?)")
    .run(slot, org, issue, pub, format, b.price);
  w.db.prepare("INSERT INTO deal_sponsors (id, org_id, name) VALUES (?, ?, ?)").run(sponsor, org, `Sponsor ${sponsor}`);
  w.db
    .prepare("INSERT INTO deal_deals (id, org_id, sponsor_id, title, stage, currency, stage_changed_at) VALUES (?, ?, ?, 'Deal', ?, ?, ?)")
    .run(deal, org, sponsor, b.stage ?? "booked", b.currency ?? "USD", now);
  w.db
    .prepare(
      "INSERT INTO deal_bookings (id, org_id, deal_id, slot_id, price_cents, currency, format, niche, audience_size, booked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(booking, org, deal, slot, b.price, b.currency ?? "USD", format, niche, audience, now);
  return booking;
}

export function optIn(w: World, org: string, at: string): void {
  w.db
    .prepare(
      "INSERT INTO bench_contributions (org_id, opted_in_at) VALUES (?, ?) ON CONFLICT (org_id) DO UPDATE SET opted_in_at = excluded.opted_in_at, revoked_at = NULL",
    )
    .run(org, at);
}

export const NOW = "2026-10-05T04:00:00.000Z";
export const LONG_AGO = "2026-08-01T00:00:00.000Z";

/**
 * A contributing org with its own owner: `prices` bookings in one cell
 * (default tech / 15k_50k / nl_primary), opted in long enough ago.
 */
export function contributor(
  w: World,
  prices: number[],
  opts: { owner?: string; optedInAt?: string; niche?: string | undefined; audience?: number | undefined; format?: string | undefined } = {},
): { org: string; owner: string } {
  const org = uuid();
  const owner = opts.owner ?? uuid();
  grant(w, org, owner, "owner");
  for (const price of prices) addBooking(w, org, { price, niche: opts.niche, audience: opts.audience, format: opts.format });
  optIn(w, org, opts.optedInAt ?? LONG_AGO);
  return { org, owner };
}

export function repo(w: World) {
  return createBenchRepository(createSqlExecutor(w.env.PLATFORM_DB!));
}

export function run(w: World, now = NOW, minOptinDays = 30) {
  return runAggregate(repo(w), { now, minOptinDays });
}

export function as(subject: string): Record<string, string> {
  return { "x-actor-subject-id": subject, "x-actor-subject-type": "user" };
}

export async function call(w: World, method: string, path: string, subject: string): Promise<{ status: number; body: any; text: string }> {
  const res = await route(new Request(`https://bench.internal${path}`, { method, headers: as(subject) }), w.env);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

/** The `data` of a read, serialized — the bytes a reader compares. */
export async function cellData(w: World, org: string, subject: string, key: { niche: string; band: string; format: string }): Promise<string> {
  const r = await call(w, "GET", `/v1/organizations/${orgPublic(org)}/benchmarks?niche=${key.niche}&band=${key.band}&format=${key.format}`, subject);
  if (r.status !== 200) throw new Error(`read ${r.status}: ${r.text}`);
  return JSON.stringify(r.body.data);
}

export const CELL = { niche: "tech", band: "15k_50k", format: "nl_primary" } as const;
