import {
  BENCH_BANDS,
  BENCH_FORMATS,
  BENCH_NICHES,
  BENCH_SHARED_FIELDS,
  type BenchBand,
  type BenchCellKey,
  type BenchCellResponse,
  type BenchContribution,
  type BenchFormat,
  type BenchNiche,
  type ContributorBand,
} from "@saas/contracts/bench";
import type { Contribution } from "@saas/db/bench";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed, type BenchAction } from "../authz.js";
import { recordConsentAudit } from "../audit.js";
import { minOptinDays } from "../config.js";
import { nowIso, openDb, type Db } from "../context.js";
import { notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid } from "../ids.js";

async function withDb(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  action: BenchAction,
  fn: (db: Db) => Promise<Response>,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, action, requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    return await fn(db);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

function present(c: Contribution | null, env: Env): BenchContribution {
  const live = c !== null && c.revokedAt === null;
  return {
    contributing: live,
    optedInAt: c?.optedInAt ?? null,
    revokedAt: c?.revokedAt ?? null,
    countsFrom: live ? new Date(Date.parse(c.optedInAt) + minOptinDays(env) * 86_400_000).toISOString() : null,
  };
}

// ── consent: owner or admin only (bench.contribute) ─────────

export async function handleGetContribution(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "bench.contribute", async (db) => {
    return successResponse({ contribution: present(await db.bench.getContribution(orgId), env), shares: BENCH_SHARED_FIELDS }, requestId);
  });
}

export async function handleOptIn(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "bench.contribute", async (db) => {
    const now = nowIso();
    const created = await db.bench.optIn(orgId, actorSubjectUuid(actor.subjectId), now);
    if (created) {
      await recordConsentAudit(db.executor, {
        type: "bench.contribution.opted_in",
        orgId,
        actor: { type: actor.subjectType, id: actor.subjectId },
        requestId,
        description: "Opted in to contribute anonymised rates to the benchmarks",
        occurredAt: now,
      });
    }
    const current = created ?? (await db.bench.getContribution(orgId));
    return successResponse({ contribution: present(current, env), shares: BENCH_SHARED_FIELDS }, requestId, created ? 201 : 200);
  });
}

export async function handleRevoke(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "bench.contribute", async (db) => {
    const now = nowIso();
    const revoked = await db.bench.revoke(orgId, actorSubjectUuid(actor.subjectId), now);
    if (!revoked) return notFound(requestId);
    await recordConsentAudit(db.executor, {
      type: "bench.contribution.revoked",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      description: "Revoked the benchmark contribution; the next weekly run no longer reads this organization's bookings",
      occurredAt: now,
    });
    return successResponse({ contribution: present(revoked, env), shares: BENCH_SHARED_FIELDS }, requestId);
  });
}

// ── reads: bench.read AND a live contribution ───────────────

async function contributing(db: Db, orgId: string): Promise<boolean> {
  const c = await db.bench.getContribution(orgId);
  return c !== null && c.revokedAt === null;
}

export async function handleListCells(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "bench.read", async (db) => {
    if (!(await contributing(db, orgId))) return notFound(requestId);
    const snapshot = await db.bench.latestSnapshot();
    const cells: BenchCellKey[] = snapshot
      ? (await db.bench.listCells(snapshot)).map((c) => ({
          niche: c.niche as BenchNiche,
          band: c.band as BenchBand,
          format: c.format as BenchFormat,
          contributors: c.contributors as ContributorBand,
        }))
      : [];
    return successResponse({ snapshot, cells }, requestId);
  });
}

/**
 * GET benchmarks?niche=&band=&format= — ONE cell, by its exact key. All three
 * keys are required and must be exact values: no wildcards, no roll-ups
 * (design §6.5, §6.6). An unpublished cell answers `{ published: false }`,
 * byte for byte the same whether it has 0 or k − 1 contributors.
 */
export async function handleReadCell(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const fields: Record<string, string[]> = {};
  const niche = q.get("niche");
  const band = q.get("band");
  const format = q.get("format");
  if (!niche || !(BENCH_NICHES as readonly string[]).includes(niche)) fields.niche = [`Required, one of ${BENCH_NICHES.join(", ")}`];
  if (!band || !(BENCH_BANDS as readonly string[]).includes(band)) fields.band = [`Required, one of ${BENCH_BANDS.join(", ")}`];
  if (!format || !(BENCH_FORMATS as readonly string[]).includes(format)) fields.format = [`Required, one of ${BENCH_FORMATS.join(", ")}`];
  q.forEach((_v, k) => {
    if (!["niche", "band", "format"].includes(k)) fields[k] = ["Unknown parameter"];
  });
  for (const k of ["niche", "band", "format"]) if (q.getAll(k).length > 1) fields[k] = ["Give exactly one value"];
  return withDb(env, requestId, actor, orgId, "bench.read", async (db) => {
    if (!(await contributing(db, orgId))) return notFound(requestId);
    if (Object.keys(fields).length) return validationError(requestId, fields);
    const snapshot = await db.bench.latestSnapshot();
    const cell = snapshot ? await db.bench.readCell(snapshot, niche!, band!, format!) : null;
    const body: BenchCellResponse = cell
      ? {
          published: true,
          niche: cell.niche as BenchNiche,
          band: cell.band as BenchBand,
          format: cell.format as BenchFormat,
          flat: { p25: cell.flatP25, p50: cell.flatP50, p75: cell.flatP75 },
          cpm: { p25: cell.cpmP25, p50: cell.cpmP50, p75: cell.cpmP75 },
          contributors: cell.contributors as ContributorBand,
          snapshot: cell.snapshot,
        }
      : { published: false };
    return successResponse(body, requestId);
  });
}
