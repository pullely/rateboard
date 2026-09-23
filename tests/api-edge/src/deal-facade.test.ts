import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDealRoute, handleDealRoute } from "@api-edge/deal-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string) => Response): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function identity(userId: string) {
  return recorder(() =>
    Response.json({
      data: {
        actor: { actorType: "user", actorId: userId, email: "ops@acme.example" },
        session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
        user: { id: userId, email: "ops@acme.example", displayName: "Ops" },
      },
      meta: { requestId: "req_inner", cursor: null },
    }),
  );
}

describe("api-edge deal facade", () => {
  it("claims the deal routes and nothing else", () => {
    for (const p of [
      "/v1/organizations/org_a/publications",
      "/v1/organizations/org_a/publications/rbp_b",
      "/v1/organizations/org_a/publications/rbp_b/issues",
      "/v1/organizations/org_a/issues/rbi_c/slots",
      "/v1/organizations/org_a/inventory",
      "/v1/organizations/org_a/sponsors",
      "/v1/organizations/org_a/sponsors/rbn_d",
      "/v1/organizations/org_a/deals",
      "/v1/organizations/org_a/deals/rbd_e",
      "/v1/organizations/org_a/deals/rbd_e/stage",
      "/v1/organizations/org_a/deals/rbd_e/bookings",
      "/v1/organizations/org_a/deals/rbd_e/bookings/rbb_f",
      "/v1/organizations/org_a/pipeline",
    ]) {
      expect(isDealRoute(p)).toBe(true);
    }
    for (const p of [
      "/v1/organizations/org_a",
      "/v1/organizations/org_a/projects",
      "/v1/organizations/org_a/members",
      "/v1/organizations/org_a/issues",
      "/v1/organizations/org_a/issues/rbi_c",
      "/v1/organizations/org_a/publications/rbp_b/issues/rbi_c",
      "/v1/organizations/org_a/deals/rbd_e/history",
      "/v1/organizations/org_a/inventoryx",
      "/v1/organizations/org_a/deals/rbd_e/bookings/rbb_f/extra",
    ]) {
      expect(isDealRoute(p)).toBe(false);
    }
  });

  it("is dispatched before the org facade would swallow it", () => {
    // index.ts checks isDealRoute before isOrgRoute; whether or not the org
    // facade's pattern also matches, the deal facade must answer these paths.
    expect(isDealRoute("/v1/organizations/org_a/deals")).toBe(true);
    expect(typeof isOrgRoute("/v1/organizations/org_a/deals")).toBe("boolean");
  });

  it("forwards an authenticated call to DEAL_WORKER with the actor (and email) as headers", async () => {
    const id = identity("usr_abc123");
    const worker = recorder(() =>
      Response.json({ data: { deal: { id: "rbd_x" } }, meta: { requestId: "req_test", cursor: null } }, { status: 200 }),
    );
    const request = new Request("https://api.example.com/v1/organizations/org_a/deals", {
      method: "POST",
      headers: {
        authorization: "Bearer sps_ses_abc.secret",
        "content-type": "application/json",
        "x-actor-subject-id": "usr_spoofed",
        "x-actor-email": "spoofed@evil.example",
      },
      body: JSON.stringify({ sponsorName: "Acme Analytics", title: "Q4 primary sponsorship" }),
    });
    const response = await handleDealRoute(
      request,
      { IDENTITY_WORKER: id.fetcher, DEAL_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/deals",
    );
    expect(response.status).toBe(200);
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]!.url).toBe("https://deal.internal/v1/organizations/org_a/deals");
    const headers = new Headers(worker.calls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123"); // never the caller's own header
    expect(headers.get("x-actor-email")).toBe("ops@acme.example");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("answers 401 without a bearer and never reaches the worker", async () => {
    const id = recorder(() => Response.json({ error: { code: "unauthenticated", message: "no", details: {}, requestId: "r" } }, { status: 401 }));
    const worker = recorder(() => Response.json({}));
    const response = await handleDealRoute(
      new Request("https://api.example.com/v1/organizations/org_a/inventory"),
      { IDENTITY_WORKER: id.fetcher, DEAL_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/inventory",
    );
    expect(response.status).toBe(401);
    expect(worker.calls).toHaveLength(0);
  });

  it("answers 503 when the binding is missing", async () => {
    const response = await handleDealRoute(
      new Request("https://api.example.com/v1/organizations/org_a/deals"),
      { ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/inventory",
    );
    expect(response.status).toBe(503);
  });

  it("wrangler.jsonc binds DEAL_WORKER on stage and prod", () => {
    const raw = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsoncComments(raw)) as {
      env: Record<string, { services?: { binding: string; service: string }[] }>;
    };
    for (const env of ["stage", "prod"]) {
      const binding = config.env[env]!.services!.find((s) => s.binding === "DEAL_WORKER");
      expect(binding?.service).toBe(`rateboard-deal-worker-${env}`);
    }
  });
});
