import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isBenchRoute, handleBenchRoute } from "@api-edge/bench-facade";
import { isDealRoute } from "@api-edge/deal-facade";

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

describe("api-edge bench facade (RB3)", () => {
  it("claims exactly the three bench paths", () => {
    for (const p of [
      "/v1/organizations/org_a/benchmark-contribution",
      "/v1/organizations/org_a/benchmarks",
      "/v1/organizations/org_a/benchmarks/cells",
    ]) {
      expect(isBenchRoute(p)).toBe(true);
      expect(isDealRoute(p)).toBe(false);
    }
    for (const p of [
      "/v1/organizations/org_a/benchmarks/cells/x",
      "/v1/organizations/org_a/benchmarks/tech",
      "/v1/organizations/org_a/benchmark-contributions",
      "/v1/benchmarks",
      "/v1/organizations/org_a/benchmarks/runs",
    ]) {
      expect(isBenchRoute(p)).toBe(false);
    }
  });

  it("forwards with the resolved actor (never the caller's) and the exact query", async () => {
    const id = identity("usr_abc123");
    const worker = recorder(() => Response.json({ data: { published: false }, meta: { requestId: "r", cursor: null } }));
    const request = new Request("https://api.example.com/v1/organizations/org_a/benchmarks?niche=tech&band=15k_50k&format=nl_primary", {
      headers: { authorization: "Bearer sps_ses_abc.secret", "x-actor-subject-id": "usr_spoofed" },
    });
    const response = await handleBenchRoute(
      request,
      { IDENTITY_WORKER: id.fetcher, BENCH_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/benchmarks",
    );
    expect(response.status).toBe(200);
    expect(worker.calls[0]!.url).toBe("https://bench.internal/v1/organizations/org_a/benchmarks?niche=tech&band=15k_50k&format=nl_primary");
    expect(new Headers(worker.calls[0]!.init.headers).get("x-actor-subject-id")).toBe("usr_abc123");
  });

  it("answers 401 without a session and 503 without the binding", async () => {
    const id = recorder(() => Response.json({ error: { code: "unauthenticated", message: "no", details: {}, requestId: "r" } }, { status: 401 }));
    const worker = recorder(() => Response.json({}));
    const r = await handleBenchRoute(
      new Request("https://api.example.com/v1/organizations/org_a/benchmarks/cells"),
      { IDENTITY_WORKER: id.fetcher, BENCH_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/benchmarks/cells",
    );
    expect(r.status).toBe(401);
    expect(worker.calls).toHaveLength(0);
    const u = await handleBenchRoute(new Request("https://api.example.com/v1/organizations/org_a/benchmarks/cells"), { ENVIRONMENT: "test" }, "req_test", "/v1/organizations/org_a/benchmarks/cells");
    expect(u.status).toBe(503);
  });

  it("wrangler.jsonc binds BENCH_WORKER on stage and prod", () => {
    const raw = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsoncComments(raw)) as { env: Record<string, { services?: { binding: string; service: string }[] }> };
    for (const env of ["stage", "prod"]) {
      expect(config.env[env]!.services!.find((s) => s.binding === "BENCH_WORKER")?.service).toBe(`rateboard-bench-worker-${env}`);
    }
  });
});
