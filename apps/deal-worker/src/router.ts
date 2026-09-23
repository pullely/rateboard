import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleCreateIssue,
  handleCreatePublication,
  handleCreateSlot,
  handleGetPublication,
  handleListPublications,
  handleUpdatePublication,
} from "./handlers/publications.js";
import { handleInventory } from "./handlers/inventory.js";
import { handleCreateSponsor, handleGetSponsor, handleListSponsors, handleUpdateSponsor } from "./handlers/sponsors.js";
import {
  handleCreateDeal,
  handleGetDeal,
  handleListDeals,
  handleMoveStage,
  handlePipeline,
  handleUpdateDeal,
} from "./handlers/deals.js";
import { handleCreateBooking, handleReleaseBooking } from "./handlers/bookings.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import {
  generateRequestId,
  parseBookingPublicId,
  parseDealPublicId,
  parseIssuePublicId,
  parseOrgPublicId,
  parsePublicationPublicId,
  parseSponsorPublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set — never as a token.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

type Handler = (request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, ids: string[]) => Promise<Response>;

interface RouteDef {
  /** Matched after /v1/organizations/{org}/; capture groups are public ids. */
  re: RegExp;
  /** The public-id parser for each capture group, in order. */
  parsers: ((id: string) => string | null)[];
  methods: Partial<Record<string, Handler>>;
}

// Every route is org-scoped: /v1/organizations/{org}/…  (design §4.1)
const ROUTES: RouteDef[] = [
  {
    re: /^publications$/,
    parsers: [],
    methods: {
      GET: (req, env, rid, actor, org) => handleListPublications(req, env, rid, actor, org),
      POST: (req, env, rid, actor, org) => handleCreatePublication(req, env, rid, actor, org),
    },
  },
  {
    re: /^publications\/([^/]+)$/,
    parsers: [parsePublicationPublicId],
    methods: {
      GET: (_req, env, rid, actor, org, [id]) => handleGetPublication(env, rid, actor, org, id!),
      PATCH: (req, env, rid, actor, org, [id]) => handleUpdatePublication(req, env, rid, actor, org, id!),
    },
  },
  {
    re: /^publications\/([^/]+)\/issues$/,
    parsers: [parsePublicationPublicId],
    methods: { POST: (req, env, rid, actor, org, [id]) => handleCreateIssue(req, env, rid, actor, org, id!) },
  },
  {
    re: /^issues\/([^/]+)\/slots$/,
    parsers: [parseIssuePublicId],
    methods: { POST: (req, env, rid, actor, org, [id]) => handleCreateSlot(req, env, rid, actor, org, id!) },
  },
  {
    re: /^inventory$/,
    parsers: [],
    methods: { GET: (req, env, rid, actor, org) => handleInventory(req, env, rid, actor, org) },
  },
  {
    re: /^sponsors$/,
    parsers: [],
    methods: {
      GET: (_req, env, rid, actor, org) => handleListSponsors(env, rid, actor, org),
      POST: (req, env, rid, actor, org) => handleCreateSponsor(req, env, rid, actor, org),
    },
  },
  {
    re: /^sponsors\/([^/]+)$/,
    parsers: [parseSponsorPublicId],
    methods: {
      GET: (_req, env, rid, actor, org, [id]) => handleGetSponsor(env, rid, actor, org, id!),
      PATCH: (req, env, rid, actor, org, [id]) => handleUpdateSponsor(req, env, rid, actor, org, id!),
    },
  },
  {
    re: /^deals$/,
    parsers: [],
    methods: {
      GET: (req, env, rid, actor, org) => handleListDeals(req, env, rid, actor, org),
      POST: (req, env, rid, actor, org) => handleCreateDeal(req, env, rid, actor, org),
    },
  },
  {
    re: /^deals\/([^/]+)$/,
    parsers: [parseDealPublicId],
    methods: {
      GET: (_req, env, rid, actor, org, [id]) => handleGetDeal(env, rid, actor, org, id!),
      PATCH: (req, env, rid, actor, org, [id]) => handleUpdateDeal(req, env, rid, actor, org, id!),
    },
  },
  {
    re: /^deals\/([^/]+)\/stage$/,
    parsers: [parseDealPublicId],
    methods: { POST: (req, env, rid, actor, org, [id]) => handleMoveStage(req, env, rid, actor, org, id!) },
  },
  {
    re: /^deals\/([^/]+)\/bookings$/,
    parsers: [parseDealPublicId],
    methods: { POST: (req, env, rid, actor, org, [id]) => handleCreateBooking(req, env, rid, actor, org, id!) },
  },
  {
    re: /^deals\/([^/]+)\/bookings\/([^/]+)$/,
    parsers: [parseDealPublicId, parseBookingPublicId],
    methods: {
      DELETE: (_req, env, rid, actor, org, [deal, booking]) => handleReleaseBooking(env, rid, actor, org, deal!, booking!),
    },
  },
  {
    re: /^pipeline$/,
    parsers: [],
    methods: { GET: (_req, env, rid, actor, org) => handlePipeline(env, rid, actor, org) },
  },
];

const ORG_PREFIX_RE = /^\/v1\/organizations\/([^/]+)\/(.+)$/;

function unauthenticated(requestId: string): Response {
  return errorResponse("unauthenticated", "Authentication required", 401, requestId);
}

async function routeOrg(request: Request, env: Env, requestId: string, path: string): Promise<Response | null> {
  const prefix = path.match(ORG_PREFIX_RE);
  if (!prefix) return null;
  const rest = prefix[2]!;
  for (const def of ROUTES) {
    const m = rest.match(def.re);
    if (!m) continue;
    const org = parseOrgPublicId(prefix[1]!);
    const ids = def.parsers.map((parse, i) => parse(m[i + 1]!));
    if (!org || ids.some((id) => id === null)) return notFound(requestId);
    const handler = def.methods[request.method];
    if (!handler) return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handler(request, env, requestId, actor, org, ids as string[]);
  }
  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const response = await routeOrg(request, env, requestId, url.pathname);
    return response ?? notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
