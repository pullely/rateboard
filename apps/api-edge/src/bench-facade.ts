import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Rateboard RB3 (bench-worker): the opt-in benchmarks. Three exact paths under
// /v1/organizations/{org}/ — benchmark-contribution (GET/PUT/DELETE, owner or
// admin), benchmarks/cells and benchmarks (GET, contributing orgs only).
// resolveActor → actor headers over the BENCH_WORKER binding; the worker runs
// membership + policy itself and answers 404 to anyone else.
const BENCH_RE = /^\/v1\/organizations\/[^/]+\/(?:benchmark-contribution|benchmarks(?:\/cells)?)$/;

const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key"];

export function isBenchRoute(pathname: string): boolean {
  return BENCH_RE.test(pathname);
}

export async function handleBenchRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  return replayOrExecute(request, requestId, env, "bench", async () => {
    if (!env.BENCH_WORKER) return errorResponse("internal_error", "Benchmarks service unavailable", 503, requestId);
    if (!env.IDENTITY_WORKER) return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return session.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://bench.internal");
    // No route here takes a body (PUT opts in with none).
    const init: RequestInit = { method: request.method, headers };
    try {
      const downstream = await timings.measure("edge_downstream", () => env.BENCH_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.bench", timings);
    } catch {
      return errorResponse("internal_error", "Benchmarks service unavailable", 503, requestId);
    }
  });
}
