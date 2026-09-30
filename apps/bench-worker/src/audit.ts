import type { SqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";

/**
 * Append a consent event and its audit row with portable SQL (as deal-worker
 * does; runbook trap 16). Best-effort: the consent write has committed. The
 * aggregate run writes NO per-org events (design §5).
 */
export async function recordConsentAudit(
  executor: SqlExecutor,
  input: { type: "bench.contribution.opted_in" | "bench.contribution.revoked"; orgId: string; actor: { type: string; id: string }; requestId: string; description: string; occurredAt: string },
): Promise<boolean> {
  const eventId = crypto.randomUUID();
  try {
    const appended = await createEventsRepository(executor).appendEvent({
      id: eventId,
      type: input.type,
      version: 1,
      source: "bench-worker",
      occurredAt: new Date(input.occurredAt),
      actorType: input.actor.type,
      actorId: input.actor.id,
      orgId: input.orgId,
      subjectKind: "organization",
      subjectId: input.orgId,
      subjectName: "Benchmark contribution",
      requestId: input.requestId,
      payload: {},
    });
    if (!appended.ok) return false;
    await executor.execute(
      `INSERT INTO events_audit_entries
         (id, event_id, org_id, project_id, environment_id, actor_type, actor_id,
          event_type, event_version, source, subject_kind, subject_id, subject_name,
          category, description, occurred_at, request_id, correlation_id, payload, redact_paths)
       SELECT $2, id, org_id, project_id, environment_id, actor_type, actor_id,
              type, version, source, subject_kind, subject_id, subject_name,
              'bench', $3, occurred_at, request_id, correlation_id, payload, redact_paths
         FROM events_event_log WHERE id = $1`,
      [eventId, crypto.randomUUID(), input.description],
    );
    return true;
  } catch {
    console.warn(JSON.stringify({ level: "warn", msg: "bench audit append failed", type: input.type, requestId: input.requestId }));
    return false;
  }
}
