import type { Env } from "../env.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, successResponse } from "../http.js";
import { toSponsorReport } from "../present.js";
import { REPORT_TOKEN_RE, sha256Hex } from "../tokens.js";

/**
 * GET /ingress/rateboard/r/{token} — the sponsor's report, with no session.
 *
 * api-edge forwards this lane with NO actor headers; the token is the only
 * credential. Unknown, malformed, revoked and expired tokens all get exactly
 * the same 404 body, so the answer tells a guesser nothing. The body is the
 * design §1.8 report only: no prices, notes, IO, other deals or members.
 */
export async function handlePublicReport(env: Env, requestId: string, token: string): Promise<Response> {
  const gone = (): Response => errorResponse("not_found", "Not found", 404, requestId);
  if (!REPORT_TOKEN_RE.test(token)) return gone();
  const db = openDb(env);
  if (!db) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  try {
    const hit = await db.paperwork.openReportLink(await sha256Hex(token), nowIso());
    if (!hit) return gone();
    const report = await db.paperwork.readReport(hit.orgId, hit.dealId);
    if (!report) return gone();
    const res = successResponse({ report: toSponsorReport(report) }, requestId);
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await db.dispose();
  }
}
