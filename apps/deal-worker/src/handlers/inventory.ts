import { INVENTORY_DEFAULT_DAYS, INVENTORY_MAX_DAYS, type InventoryResponse } from "@saas/contracts/deal";
import type { Slot } from "@saas/db/deal";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { addDays, todayUtc } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { parsePublicationPublicId } from "../ids.js";
import { toPublicIssue } from "../present.js";
import { validateRange } from "../validate.js";
import { withDb } from "./common.js";

/**
 * GET inventory?from=&to=&publication= — the calendar: issues in [from, to],
 * each with its slots and each slot's live booking (or null when open).
 */
export async function handleInventory(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const v = validateRange(params.get("from"), params.get("to"));
  if (!v.valid) return validationError(requestId, v.fields);
  const from = v.value.from ?? todayUtc();
  const to = v.value.to ?? addDays(from, INVENTORY_DEFAULT_DAYS);
  if (to < from) return validationError(requestId, { to: ["Must not be before from"] });
  if (to > addDays(from, INVENTORY_MAX_DAYS)) return validationError(requestId, { to: [`At most ${INVENTORY_MAX_DAYS} days after from`] });
  let publicationId: string | undefined;
  const rawPub = params.get("publication");
  if (rawPub !== null) {
    const parsed = parsePublicationPublicId(rawPub);
    if (!parsed) return validationError(requestId, { publication: ["Not a publication id"] });
    publicationId = parsed;
  }
  return withDb(env, requestId, actor, orgId, "deal.read", async (db) => {
    const [issues, slots] = await Promise.all([
      db.deals.listIssuesInRange(orgId, from, to, publicationId),
      db.deals.listSlotsInRange(orgId, from, to, publicationId),
    ]);
    const byIssue = new Map<string, Slot[]>();
    for (const s of slots) {
      const list = byIssue.get(s.issueId) ?? [];
      list.push(s);
      byIssue.set(s.issueId, list);
    }
    const data: InventoryResponse = { from, to, issues: issues.map((i) => toPublicIssue(i, byIssue.get(i.id) ?? [])) };
    return successResponse(data, requestId);
  });
}
