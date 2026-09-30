import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";
import type { Env } from "./env.js";

export type EnqueueResult = { ok: true; notificationId: string } | { ok: false; reason: "no_binding" | "non_2xx" | "network_error" | "bad_response" };

/**
 * POST the V1 enqueue contract to notifications-worker over the service
 * binding, as `deal-worker` (on its internal-actor allow-list since RB1).
 * Never throws. "ok" means the notifications worker ACCEPTED the send — not
 * that the email was delivered (runbook trap 27).
 */
export async function enqueueEmail(
  env: Env,
  ctx: { requestId: string; actorSubjectType: string; actorSubjectId: string },
  request: EnqueueNotificationRequest,
): Promise<EnqueueResult> {
  if (!env.NOTIFICATIONS_WORKER) return { ok: false, reason: "no_binding" };
  let response: Response;
  try {
    response = await env.NOTIFICATIONS_WORKER.fetch("https://notifications.internal/v1/notifications", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": ctx.requestId,
        "x-internal-actor": "deal-worker",
        "x-actor-subject-type": ctx.actorSubjectType,
        "x-actor-subject-id": ctx.actorSubjectId,
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (!response.ok) return { ok: false, reason: "non_2xx" };
  try {
    const parsed = (await response.json()) as { data?: { notification?: { id?: unknown } } };
    const id = parsed?.data?.notification?.id;
    return typeof id === "string" && id.length > 0 ? { ok: true, notificationId: id } : { ok: false, reason: "bad_response" };
  } catch {
    return { ok: false, reason: "bad_response" };
  }
}
