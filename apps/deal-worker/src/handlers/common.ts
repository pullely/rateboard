import type { DealConflictReason } from "@saas/contracts/deal";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit, type DealSubjectKind } from "../audit.js";
import { openDb, type Db } from "../context.js";
import { errorResponse, notFound, unavailable, validationError } from "../http.js";

export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export function invalidJson(requestId: string): Response {
  return validationError(requestId, { body: ["Invalid JSON"] });
}

export function conflict(
  requestId: string,
  reason: DealConflictReason,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return errorResponse("conflict", message, 409, requestId, { reason, ...details });
}

/**
 * Authorize, open the database, run `fn`, always dispose. Deny-by-default: a
 * caller without `action` on the org gets 404, never 403, so a non-member
 * cannot probe whether anything exists. Any throw is a 503, never a 500 that
 * leaks a stack or tempts a client to retry a write that may have committed.
 */
export async function withDb(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  action: "deal.read" | "deal.write",
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

export interface AuditArgs {
  type: string;
  kind: DealSubjectKind;
  subjectId: string;
  subjectName: string;
  description: string;
  payload: Record<string, unknown>;
}

/** Best-effort audit of a write that has already committed (see audit.ts). */
export function audit(db: Db, actor: ActorContext, requestId: string, orgId: string, now: string, a: AuditArgs): Promise<boolean> {
  return recordAudit(db.executor, {
    type: a.type,
    orgId,
    actor: { type: actor.subjectType, id: actor.subjectId },
    requestId,
    subjectKind: a.kind,
    subjectId: a.subjectId,
    subjectName: a.subjectName,
    description: a.description,
    payload: a.payload,
    occurredAt: now,
  });
}

export function formatMoney(cents: number | null, currency: string): string {
  if (cents === null) return "no value";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
