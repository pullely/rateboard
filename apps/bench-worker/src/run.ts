import { BENCH_WINDOW_DAYS } from "@saas/contracts/bench";
import type { BenchRepository } from "@saas/db/bench";
import { computeSnapshot, isoWeek, memberOf, type SnapshotOutput } from "./aggregate.js";

export interface RunReport {
  snapshot: string;
  contributors: number;
  cellsPublished: number;
  cellsWithheld: number;
  output: SnapshotOutput;
}

/**
 * One aggregate run: read the contributed bookings (the one cross-tenant
 * read), compute, write the new snapshot, and only then mark the run done —
 * so a run that fails leaves the previous snapshot serving (design §6.8).
 */
export async function runAggregate(repo: BenchRepository, opts: { now: string; minOptinDays: number }): Promise<RunReport | null> {
  const runId = crypto.randomUUID();
  const run = await repo.startRun({ id: runId, week: isoWeek(opts.now), now: opts.now });
  if (!run) return null; // another run claimed the label at the same moment
  try {
    const since = new Date(Date.parse(opts.now) - BENCH_WINDOW_DAYS * 86_400_000).toISOString();
    const bookings = await repo.readContributedBookings({ since });
    const orgIds = [...new Set(bookings.map((b) => b.orgId))].sort();
    const admins = orgIds.length ? await repo.readOrgAdmins(orgIds) : [];
    const members = new Map<string, string>();
    for (const org of orgIds) members.set(org, await memberOf(org));
    const published = await repo.readPublishedMembers();
    const output = computeSnapshot({ bookings, admins, now: opts.now, minOptinDays: opts.minOptinDays, published, members, snapshot: run.snapshot });
    await repo.writeCells(output.cells);
    await repo.writeMembers(output.memberRows);
    await repo.finishRun({
      id: runId,
      now: new Date().toISOString(),
      contributors: output.contributors,
      cellsPublished: output.cells.length,
      cellsWithheld: output.withheld.length,
    });
    await repo.pruneCells(run.snapshot);
    return { snapshot: run.snapshot, contributors: output.contributors, cellsPublished: output.cells.length, cellsWithheld: output.withheld.length, output };
  } catch (err) {
    await repo.failRun(runId, new Date().toISOString()).catch(() => undefined);
    throw err;
  }
}
