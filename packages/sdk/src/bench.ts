import type { BenchCellResponse, BenchCellsResponse, BenchContributionResponse } from "@saas/contracts/bench";

import type { RequestOptions, Transport } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}`;

/**
 * Rateboard benchmarks client (RB3) — the org's opt-in to contribute, and the
 * published benchmark cells. Maps to `apps/bench-worker` through api-edge's
 * bench facade. Reads answer 404 unless the org is contributing.
 */
export class BenchClient {
  constructor(private readonly transport: Transport) {}

  getContribution(orgId: string, opts: RequestOptions = {}): Promise<BenchContributionResponse> {
    return this.transport.request<BenchContributionResponse>({ method: "GET", path: `${org(orgId)}/benchmark-contribution` }, opts);
  }

  /** Opt in (owner or admin). Re-opting in after a revocation is a new consent. */
  optIn(orgId: string, opts: RequestOptions = {}): Promise<BenchContributionResponse> {
    return this.transport.request<BenchContributionResponse>({ method: "PUT", path: `${org(orgId)}/benchmark-contribution` }, opts);
  }

  /** Revoke (owner or admin): the next run no longer reads this org's bookings. */
  revoke(orgId: string, opts: RequestOptions = {}): Promise<BenchContributionResponse> {
    return this.transport.request<BenchContributionResponse>({ method: "DELETE", path: `${org(orgId)}/benchmark-contribution` }, opts);
  }

  /** The cells published in the latest snapshot, each with its contributor band. */
  listCells(orgId: string, opts: RequestOptions = {}): Promise<BenchCellsResponse> {
    return this.transport.request<BenchCellsResponse>({ method: "GET", path: `${org(orgId)}/benchmarks/cells` }, opts);
  }

  /** One cell by its exact key; `{ published: false }` when it is not published. */
  getCell(orgId: string, key: { niche: string; band: string; format: string }, opts: RequestOptions = {}): Promise<BenchCellResponse> {
    return this.transport.request<BenchCellResponse>({ method: "GET", path: `${org(orgId)}/benchmarks`, query: key }, opts);
  }
}
