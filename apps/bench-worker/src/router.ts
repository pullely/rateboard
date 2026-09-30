import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleGetContribution, handleListCells, handleOptIn, handleReadCell, handleRevoke } from "./handlers/bench.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/** Reachable only over api-edge's BENCH_WORKER binding: the actor arrives as headers the edge resolved. */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

type Handler = (request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string) => Promise<Response>;

// design §4.3 — every route org-scoped, exact paths only.
const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "benchmark-contribution": {
    GET: (_r, env, rid, actor, org) => handleGetContribution(env, rid, actor, org),
    PUT: (_r, env, rid, actor, org) => handleOptIn(env, rid, actor, org),
    DELETE: (_r, env, rid, actor, org) => handleRevoke(env, rid, actor, org),
  },
  "benchmarks/cells": {
    GET: (_r, env, rid, actor, org) => handleListCells(env, rid, actor, org),
  },
  benchmarks: {
    GET: (r, env, rid, actor, org) => handleReadCell(r, env, rid, actor, org),
  },
};

const ORG_PREFIX_RE = /^\/v1\/organizations\/([^/]+)\/(.+)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const m = url.pathname.match(ORG_PREFIX_RE);
    const methods = m ? ROUTES[m[2]!] : undefined;
    if (!m || !methods) return notFound(requestId, url.pathname);
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    const handler = methods[request.method];
    if (!handler) return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    return await handler(request, env, requestId, actor, org);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
