import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import type { Env } from "@deal-worker/env";

// A real SQLite engine under the worker, not a mocked executor: D1 is SQLite,
// so a statement node:sqlite runs is a statement D1 runs — including the
// RETURNING-based writes this context relies on (runbook trap 22).

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
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

export const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "22222222-2222-4222-8222-222222222222";
export const VIEWER = "33333333-3333-4333-8333-333333333333";
export const OTHER_OWNER = "44444444-4444-4444-8444-444444444444";
export const STRANGER = "99999999-9999-4999-8999-999999999999";

/**
 * membership-worker + policy-worker stand-ins, org-aware and mirroring the
 * policy engine: in ORG_A, OWNER is the owner and MEMBER a builder (both read
 * and write deals) and VIEWER only reads; OTHER_OWNER owns ORG_B and nothing
 * else; STRANGER is nobody anywhere.
 */
const MEMBERSHIPS: Record<string, Record<string, string>> = {
  [OWNER]: { [ORG_A]: "owner" },
  [MEMBER]: { [ORG_A]: "builder" },
  [VIEWER]: { [ORG_A]: "viewer" },
  [OTHER_OWNER]: { [ORG_B]: "owner" },
};
const ROLE_ACTIONS: Record<string, ReadonlySet<string>> = {
  owner: new Set(["deal.read", "deal.write"]),
  builder: new Set(["deal.read", "deal.write"]),
  viewer: new Set(["deal.read"]),
};

export function fakeFleet(): { MEMBERSHIP_WORKER: Fetcher; POLICY_WORKER: Fetcher } {
  const membership = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string }; orgId: string };
      const role = MEMBERSHIPS[body.subject.id]?.[body.orgId] ?? null;
      return Response.json({ data: { memberships: role ? [{ kind: "organization", orgId: body.orgId, role }] : [] } });
    },
  };
  const policy = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as {
        action: string;
        resource: { orgId: string };
        context: { memberships: { orgId: string; role: string }[] };
      };
      const role = body.context.memberships.find((m) => m.orgId === body.resource.orgId)?.role;
      const allow = role !== undefined && (ROLE_ACTIONS[role]?.has(body.action) ?? false);
      return Response.json({ data: { allow } });
    },
  };
  return { MEMBERSHIP_WORKER: membership as unknown as Fetcher, POLICY_WORKER: policy as unknown as Fetcher };
}

export interface TestWorld {
  env: Env;
  db: DatabaseSync;
}

export function world(): TestWorld {
  const db = migratedDatabase();
  const fleet = fakeFleet();
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db),
    MEMBERSHIP_WORKER: fleet.MEMBERSHIP_WORKER,
    POLICY_WORKER: fleet.POLICY_WORKER,
  } as Env;
  return { env, db };
}

export function as(subjectId: string): Record<string, string> {
  return { "x-actor-subject-id": subjectId, "x-actor-subject-type": "user" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test payloads are asserted field by field
export async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}
