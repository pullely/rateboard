import type { BenchRepository } from "@saas/db/bench";
import type { SqlExecutor } from "@saas/db/d1";
import { createBenchRepository } from "@saas/db/bench";
import { createSqlExecutor } from "@saas/db/d1";
import type { Env } from "./env.js";

export interface Db {
  executor: SqlExecutor;
  bench: BenchRepository;
}

export function openDb(env: Env): (Db & { dispose(): Promise<void> }) | null {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  return { executor, bench: createBenchRepository(executor), dispose: () => executor.dispose() };
}

export function nowIso(): string {
  return new Date().toISOString();
}
