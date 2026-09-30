import type { Env } from "./env.js";
import { minOptinDays } from "./config.js";
import { openDb } from "./context.js";
import { route } from "./router.js";
import { runAggregate } from "./run.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * The benchmark aggregate. Prod: Mondays 04:00 UTC (design §6.8). Stage runs
   * it more often (a recorded departure) so the end-to-end check can see a
   * publish and a withhold. Only totals are logged — never an org or a value.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = openDb(env);
    if (!db) return;
    ctx.waitUntil(
      (async () => {
        try {
          const report = await runAggregate(db.bench, { now: new Date().toISOString(), minOptinDays: minOptinDays(env) });
          console.warn(
            JSON.stringify({
              level: "info",
              msg: "bench aggregate",
              snapshot: report?.snapshot ?? null,
              contributors: report?.contributors ?? null,
              cellsPublished: report?.cellsPublished ?? null,
              cellsWithheld: report?.cellsWithheld ?? null,
            }),
          );
        } catch {
          console.warn(JSON.stringify({ level: "warn", msg: "bench aggregate failed; the previous snapshot keeps serving" }));
        } finally {
          await db.dispose();
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
