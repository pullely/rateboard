import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type { BenchCellRow, BenchRepository, BenchRun, ContributedBooking, Contribution, OrgAdmin } from "./types.js";

type Row = SqlRow & Record<string, unknown>;

/** D1 accepts at most 100 bound parameters per statement. */
const MAX_PARAMS = 99;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapContribution(row: Row): Contribution {
  return {
    orgId: row.org_id as string,
    optedInAt: row.opted_in_at as string,
    optedInBy: str(row.opted_in_by),
    revokedAt: str(row.revoked_at),
    revokedBy: str(row.revoked_by),
  };
}

function mapRun(row: Row): BenchRun {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id as string,
    snapshot: row.snapshot as string,
    status: row.status as string,
    startedAt: row.started_at as string,
    finishedAt: str(row.finished_at),
    contributors: n(row.contributors),
    cellsPublished: n(row.cells_published),
    cellsWithheld: n(row.cells_withheld),
  };
}

function mapCell(row: Row): BenchCellRow {
  return {
    snapshot: row.snapshot as string,
    niche: row.niche as string,
    band: row.band as string,
    format: row.format as string,
    flatP25: Number(row.flat_p25),
    flatP50: Number(row.flat_p50),
    flatP75: Number(row.flat_p75),
    cpmP25: Number(row.cpm_p25),
    cpmP50: Number(row.cpm_p50),
    cpmP75: Number(row.cpm_p75),
    contributors: row.contributors as string,
  };
}

const CONTRIBUTION_COLUMNS = "org_id, opted_in_at, opted_in_by, revoked_at, revoked_by";
const RUN_COLUMNS = "id, snapshot, status, started_at, finished_at, contributors, cells_published, cells_withheld";
const CELL_COLUMNS = "snapshot, niche, band, format, flat_p25, flat_p50, flat_p75, cpm_p25, cpm_p50, cpm_p75, contributors";

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createBenchRepository(executor: SqlExecutor): BenchRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    return (await executor.execute<Row>(sql, params)).rows[0] ?? null;
  }
  async function many(sql: string, params: unknown[]): Promise<Row[]> {
    return (await executor.execute<Row>(sql, params)).rows;
  }

  const repo: BenchRepository = {
    // ── consent ──────────────────────────────────────────────
    async getContribution(orgId) {
      const row = await one(`SELECT ${CONTRIBUTION_COLUMNS} FROM bench_contributions WHERE org_id = $1`, [orgId]);
      return row ? mapContribution(row) : null;
    },

    async optIn(orgId, by, now) {
      // A first opt-in inserts; a re-opt-in after a revocation is a NEW consent
      // (new opted_in_at, so the minimum age starts again). While live, nothing
      // changes and no row comes back.
      const row = await one(
        `INSERT INTO bench_contributions (org_id, opted_in_at, opted_in_by) VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE SET opted_in_at = excluded.opted_in_at, opted_in_by = excluded.opted_in_by,
                                            revoked_at = NULL, revoked_by = NULL
          WHERE bench_contributions.revoked_at IS NOT NULL
         RETURNING ${CONTRIBUTION_COLUMNS}`,
        [orgId, now, by],
      );
      return row ? mapContribution(row) : null;
    },

    async revoke(orgId, by, now) {
      const row = await one(
        `UPDATE bench_contributions SET revoked_at = $2, revoked_by = $3
          WHERE org_id = $1 AND revoked_at IS NULL
          RETURNING ${CONTRIBUTION_COLUMNS}`,
        [orgId, now, by],
      );
      return row ? mapContribution(row) : null;
    },

    // ── the aggregate ────────────────────────────────────────
    async readContributedBookings(window) {
      // THE cross-tenant read (design §6.3). One statement; the consent join is
      // in it, so a revoked org's rows are never read, not read-then-dropped.
      const rows = await many(
        `SELECT b.org_id, b.format, b.niche, b.audience_size, b.price_cents, b.currency, c.opted_in_at
           FROM deal_bookings b
           JOIN deal_deals d ON d.id = b.deal_id AND d.org_id = b.org_id
           JOIN bench_contributions c ON c.org_id = b.org_id AND c.revoked_at IS NULL
          WHERE b.released_at IS NULL
            AND d.stage IN ('booked', 'delivered', 'paid')
            AND b.booked_at >= $1
            AND b.currency = 'USD'
            AND b.niche <> 'other'
            AND b.format <> 'other'
            AND b.audience_size > 0`,
        [window.since],
      );
      return rows.map(
        (r): ContributedBooking => ({
          orgId: r.org_id as string,
          format: r.format as string,
          niche: r.niche as string,
          audienceSize: Number(r.audience_size),
          priceCents: Number(r.price_cents),
          currency: r.currency as string,
          optedInAt: r.opted_in_at as string,
        }),
      );
    },

    async readOrgAdmins(orgIds) {
      const out: OrgAdmin[] = [];
      for (const part of chunks(orgIds, MAX_PARAMS)) {
        const params = part.map((_, i) => `$${i + 1}`).join(", ");
        const rows = await many(
          `SELECT ra.org_id, ra.subject_id
             FROM membership_role_assignments ra
             JOIN membership_organization_members m
               ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id AND m.status = 'active'
            WHERE ra.org_id IN (${params})
              AND ra.role IN ('owner', 'admin') AND ra.scope_kind = 'organization' AND ra.revoked_at IS NULL`,
          [...part],
        );
        for (const r of rows) out.push({ orgId: r.org_id as string, subjectId: r.subject_id as string });
      }
      return out;
    },

    async startRun(input) {
      // The label is claimed in the INSERT under UNIQUE (snapshot): the first
      // run of a week is the week itself, later ones get ".<n>".
      const row = await one(
        `INSERT INTO bench_runs (id, snapshot, status, started_at)
         SELECT $1,
                CASE WHEN COUNT(*) = 0 THEN $2 ELSE $2 || '.' || (COUNT(*) + 1) END,
                'running', $3
           FROM bench_runs WHERE snapshot = $2 OR snapshot LIKE $2 || '.%'
         ON CONFLICT DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [input.id, input.week, input.now],
      );
      return row ? mapRun(row) : null;
    },

    async finishRun(input) {
      await executor.execute(
        `UPDATE bench_runs SET status = 'done', finished_at = $2, contributors = $3, cells_published = $4, cells_withheld = $5
          WHERE id = $1 RETURNING id`,
        [input.id, input.now, input.contributors, input.cellsPublished, input.cellsWithheld],
      );
    },

    async failRun(id, now) {
      await executor.execute(`UPDATE bench_runs SET status = 'failed', finished_at = $2 WHERE id = $1 RETURNING id`, [id, now]);
    },

    async latestSnapshot() {
      const row = await one(
        `SELECT snapshot FROM bench_runs WHERE status = 'done' ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
        [],
      );
      return row ? (row.snapshot as string) : null;
    },

    async listRuns(limit) {
      return (await many(`SELECT ${RUN_COLUMNS} FROM bench_runs ORDER BY started_at DESC, rowid DESC LIMIT $1`, [limit])).map(mapRun);
    },

    async readPublishedMembers() {
      const rows = await many(`SELECT cell_key, snapshot, member FROM bench_cell_contributors`, []);
      const out = new Map<string, Map<string, Set<string>>>();
      for (const r of rows) {
        const cell = out.get(r.cell_key as string) ?? new Map<string, Set<string>>();
        const set = cell.get(r.snapshot as string) ?? new Set<string>();
        set.add(r.member as string);
        cell.set(r.snapshot as string, set);
        out.set(r.cell_key as string, cell);
      }
      return out;
    },

    async writeCells(rows) {
      const cols = 11;
      for (const part of chunks(rows, Math.floor(MAX_PARAMS / cols))) {
        const values = part.map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(", ")})`).join(", ");
        const params = part.flatMap((c) => [
          c.snapshot, c.niche, c.band, c.format, c.flatP25, c.flatP50, c.flatP75, c.cpmP25, c.cpmP50, c.cpmP75, c.contributors,
        ]);
        await executor.execute(`INSERT INTO bench_cells (${CELL_COLUMNS}) VALUES ${values} ON CONFLICT DO NOTHING RETURNING snapshot`, params);
      }
    },

    async writeMembers(rows) {
      const cols = 3;
      for (const part of chunks(rows, Math.floor(MAX_PARAMS / cols))) {
        const values = part.map((_, i) => `($${i * cols + 1}, $${i * cols + 2}, $${i * cols + 3})`).join(", ");
        const params = part.flatMap((m) => [m.cellKey, m.snapshot, m.member]);
        await executor.execute(
          `INSERT INTO bench_cell_contributors (cell_key, snapshot, member) VALUES ${values} ON CONFLICT DO NOTHING RETURNING cell_key`,
          params,
        );
      }
    },

    async pruneCells(keep) {
      await executor.execute(`DELETE FROM bench_cells WHERE snapshot <> $1 RETURNING snapshot`, [keep]);
    },

    // ── reads ────────────────────────────────────────────────
    async readCell(snapshot, niche, band, format) {
      const row = await one(
        `SELECT ${CELL_COLUMNS} FROM bench_cells WHERE snapshot = $1 AND niche = $2 AND band = $3 AND format = $4`,
        [snapshot, niche, band, format],
      );
      return row ? mapCell(row) : null;
    },

    async listCells(snapshot) {
      return (await many(`SELECT ${CELL_COLUMNS} FROM bench_cells WHERE snapshot = $1 ORDER BY niche, band, format`, [snapshot])).map(mapCell);
    },
  };
  return repo;
}
