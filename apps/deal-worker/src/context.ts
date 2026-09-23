import type { Env } from "./env.js";
import type { DealRepository } from "@saas/db/deal";
import type { SqlExecutor } from "@saas/db/d1";
import { createDealRepository } from "@saas/db/deal";
import { createSqlExecutor } from "@saas/db/d1";

export interface Db {
  executor: SqlExecutor;
  deals: DealRepository;
}

/** Open the request's database handle, or null when the binding is missing. */
export function openDb(env: Env): (Db & { dispose(): Promise<void> }) | null {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  return { executor, deals: createDealRepository(executor), dispose: () => executor.dispose() };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayUtc(now: string = nowIso()): string {
  return now.slice(0, 10);
}

/** YYYY-MM-DD plus n days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
