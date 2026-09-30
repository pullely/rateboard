import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";

export type BenchAction = "bench.contribute" | "bench.read";

/**
 * membership-context → policy-authorize, deny-by-default. The caller turns
 * `false` into 404 (never 403), so a non-member cannot probe anything.
 */
export async function allowed(env: Env, actor: ActorContext, orgId: string, action: BenchAction, requestId: string): Promise<boolean> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) return false;
  const context = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId, requestId);
  if (!context.ok) return false;
  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    action,
    { kind: "organization", orgId },
    context.memberships,
    requestId,
  );
  return decision.allow;
}
