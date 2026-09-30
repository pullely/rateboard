import { BENCH_MIN_OPTIN_DAYS } from "@saas/contracts/bench";
import type { Env } from "./env.js";

/**
 * The opt-in age a run applies. 30 days by design. A stage deployment may
 * lower it through BENCH_MIN_OPTIN_DAYS (a recorded departure) so the
 * end-to-end check can build k eligible contributors today; production can
 * never lower it — the override is not in its vars, and it is ignored here
 * even if it were.
 */
export function minOptinDays(env: Pick<Env, "ENVIRONMENT" | "BENCH_MIN_OPTIN_DAYS">): number {
  if (env.ENVIRONMENT === "prod") return BENCH_MIN_OPTIN_DAYS;
  const raw = env.BENCH_MIN_OPTIN_DAYS;
  if (raw === undefined || raw === null || raw.trim() === "") return BENCH_MIN_OPTIN_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= BENCH_MIN_OPTIN_DAYS ? n : BENCH_MIN_OPTIN_DAYS;
}
