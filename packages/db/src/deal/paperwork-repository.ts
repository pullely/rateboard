import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  Delivery,
  InsertionOrder,
  PaperworkRepository,
  PublicReport,
  ReportLine,
  ReportLink,
} from "./paperwork-types.js";

type Row = SqlRow & Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const IO_COLUMNS = `id, org_id, deal_id, seq, terms, total_cents, currency, payment_due_on, status, send_count,
  sent_at, sent_to, notification_id, signed_at, created_by, created_at, updated_at`;

const DELIVERY_COLUMNS = `id, org_id, deal_id, booking_id, delivered_on, proof_url, opens, clicks, impressions,
  downloads, notes, recorded_by, created_at, updated_at`;

const LINK_COLUMNS = `id, org_id, deal_id, expires_at, last_viewed_at, view_count, created_by, created_at, revoked_at`;

function mapIo(row: Row): InsertionOrder {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    dealId: row.deal_id as string,
    seq: Number(row.seq),
    terms: (row.terms as string) ?? "",
    totalCents: Number(row.total_cents),
    currency: row.currency as string,
    paymentDueOn: str(row.payment_due_on),
    status: row.status as string,
    sendCount: Number(row.send_count ?? 0),
    sentAt: str(row.sent_at),
    sentTo: str(row.sent_to),
    notificationId: str(row.notification_id),
    signedAt: str(row.signed_at),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDelivery(row: Row): Delivery {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    dealId: row.deal_id as string,
    bookingId: row.booking_id as string,
    deliveredOn: row.delivered_on as string,
    proofUrl: str(row.proof_url),
    opens: num(row.opens),
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    downloads: num(row.downloads),
    notes: (row.notes as string) ?? "",
    recordedBy: str(row.recorded_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapLink(row: Row): ReportLink {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    dealId: row.deal_id as string,
    expiresAt: str(row.expires_at),
    lastViewedAt: str(row.last_viewed_at),
    viewCount: Number(row.view_count ?? 0),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    revokedAt: str(row.revoked_at),
  };
}

export function createPaperworkRepository(executor: SqlExecutor): PaperworkRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }
  async function many(sql: string, params: unknown[]): Promise<Row[]> {
    return (await executor.execute<Row>(sql, params)).rows;
  }

  const repo: PaperworkRepository = {
    // ── insertion orders ─────────────────────────────────────
    async createInsertionOrder(input) {
      // The number is claimed inside the INSERT: MAX(seq) + 1 for this org,
      // under UNIQUE (org_id, seq). SQLite (so D1) runs one statement at a
      // time, so two concurrent creates read different MAX values; if a
      // platform ever interleaved them, the loser hits the index, DO NOTHING
      // returns no row, and the caller retries once. UNIQUE (deal_id) makes a
      // second IO for the same deal a no-row as well.
      const row = await one(
        `INSERT INTO deal_insertion_orders
           (id, org_id, deal_id, seq, terms, total_cents, currency, payment_due_on, status, created_by, created_at, updated_at)
         SELECT $1, d.org_id, d.id,
                (SELECT COALESCE(MAX(o.seq), 0) + 1 FROM deal_insertion_orders o WHERE o.org_id = d.org_id),
                $4,
                COALESCE($5, (SELECT COALESCE(SUM(b.price_cents), 0) FROM deal_bookings b
                               WHERE b.deal_id = d.id AND b.org_id = d.org_id AND b.released_at IS NULL)),
                d.currency, $6, 'draft', $7, $8, $8
           FROM deal_deals d
          WHERE d.id = $3 AND d.org_id = $2 AND d.stage IN ('booked', 'delivered', 'paid')
         ON CONFLICT DO NOTHING
         RETURNING ${IO_COLUMNS}`,
        [input.id, input.orgId, input.dealId, input.terms, input.totalCents, input.paymentDueOn, input.createdBy, input.now],
      );
      return row ? mapIo(row) : null;
    },

    async getInsertionOrder(orgId, dealId) {
      const row = await one(`SELECT ${IO_COLUMNS} FROM deal_insertion_orders WHERE org_id = $1 AND deal_id = $2`, [orgId, dealId]);
      return row ? mapIo(row) : null;
    },

    async updateInsertionOrder(orgId, dealId, f, now) {
      const row = await one(
        `UPDATE deal_insertion_orders SET terms = $3, total_cents = $4, payment_due_on = $5, updated_at = $6
          WHERE org_id = $1 AND deal_id = $2 AND status <> 'signed'
          RETURNING ${IO_COLUMNS}`,
        [orgId, dealId, f.terms, f.totalCents, f.paymentDueOn, now],
      );
      return row ? mapIo(row) : null;
    },

    async signInsertionOrder(orgId, dealId, now) {
      const row = await one(
        `UPDATE deal_insertion_orders SET status = 'signed', signed_at = $3, updated_at = $3
          WHERE org_id = $1 AND deal_id = $2 AND status <> 'signed'
          RETURNING ${IO_COLUMNS}`,
        [orgId, dealId, now],
      );
      return row ? mapIo(row) : null;
    },

    async markInsertionOrderSent(input) {
      const row = await one(
        `UPDATE deal_insertion_orders
            SET status = 'sent', send_count = send_count + 1, sent_at = $4, sent_to = $5, notification_id = $6, updated_at = $4
          WHERE org_id = $1 AND deal_id = $2 AND send_count = $3 AND status <> 'signed'
          RETURNING ${IO_COLUMNS}`,
        [input.orgId, input.dealId, input.expectedSendCount, input.now, input.sentTo, input.notificationId],
      );
      return row ? mapIo(row) : null;
    },

    // ── deliveries ───────────────────────────────────────────
    async upsertDelivery(input) {
      // One statement: the booking must be live in this deal and the deal
      // booked or later; the unique booking_id makes a second PUT a replace.
      const row = await one(
        `INSERT INTO deal_deliveries
           (id, org_id, deal_id, booking_id, delivered_on, proof_url, opens, clicks, impressions, downloads, notes,
            recorded_by, created_at, updated_at)
         SELECT $1, b.org_id, b.deal_id, b.id, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
           FROM deal_bookings b
           JOIN deal_deals d ON d.id = b.deal_id AND d.org_id = b.org_id
          WHERE b.id = $4 AND b.deal_id = $3 AND b.org_id = $2 AND b.released_at IS NULL
            AND d.stage IN ('booked', 'delivered', 'paid')
         ON CONFLICT (booking_id) DO UPDATE SET
           delivered_on = excluded.delivered_on, proof_url = excluded.proof_url, opens = excluded.opens,
           clicks = excluded.clicks, impressions = excluded.impressions, downloads = excluded.downloads,
           notes = excluded.notes, recorded_by = excluded.recorded_by, updated_at = excluded.updated_at
         RETURNING ${DELIVERY_COLUMNS}`,
        [input.id, input.orgId, input.dealId, input.bookingId, input.deliveredOn, input.proofUrl, input.opens, input.clicks,
          input.impressions, input.downloads, input.notes, input.recordedBy, input.now],
      );
      return row ? mapDelivery(row) : null;
    },

    async listDeliveriesForDeal(orgId, dealId) {
      const rows = await many(
        `SELECT ${DELIVERY_COLUMNS} FROM deal_deliveries WHERE org_id = $1 AND deal_id = $2 ORDER BY delivered_on ASC, id ASC`,
        [orgId, dealId],
      );
      return rows.map(mapDelivery);
    },

    async countUndeliveredBookings(orgId, dealId) {
      const row = await one(
        `SELECT COUNT(*) AS n FROM deal_bookings b
          WHERE b.org_id = $1 AND b.deal_id = $2 AND b.released_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM deal_deliveries v WHERE v.booking_id = b.id AND v.org_id = b.org_id)`,
        [orgId, dealId],
      );
      return Number(row?.n ?? 0);
    },

    // ── report links ─────────────────────────────────────────
    async createReportLink(input) {
      // The partial unique index uq_deal_report_links_live allows one live link
      // per deal: a second create inserts nothing and returns no row.
      const row = await one(
        `INSERT INTO deal_report_links (id, org_id, deal_id, token_sha256, expires_at, created_by, created_at)
         SELECT $1, d.org_id, d.id, $4, $5, $6, $7 FROM deal_deals d WHERE d.id = $3 AND d.org_id = $2
         ON CONFLICT DO NOTHING
         RETURNING ${LINK_COLUMNS}`,
        [input.id, input.orgId, input.dealId, input.tokenSha256, input.expiresAt, input.createdBy, input.now],
      );
      return row ? mapLink(row) : null;
    },

    async listReportLinks(orgId, dealId) {
      const rows = await many(
        `SELECT ${LINK_COLUMNS} FROM deal_report_links WHERE org_id = $1 AND deal_id = $2
          ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 50`,
        [orgId, dealId],
      );
      return rows.map(mapLink);
    },

    async getReportLink(orgId, dealId, id) {
      const row = await one(`SELECT ${LINK_COLUMNS} FROM deal_report_links WHERE org_id = $1 AND deal_id = $2 AND id = $3`, [orgId, dealId, id]);
      return row ? mapLink(row) : null;
    },

    async revokeReportLink(input) {
      const row = await one(
        `UPDATE deal_report_links SET revoked_at = $4, revoked_by = $5
          WHERE org_id = $1 AND deal_id = $2 AND id = $3 AND revoked_at IS NULL
          RETURNING ${LINK_COLUMNS}`,
        [input.orgId, input.dealId, input.id, input.now, input.revokedBy],
      );
      return row ? mapLink(row) : null;
    },

    async openReportLink(tokenSha256, now) {
      // Unknown, revoked and expired all come back as no row — the caller
      // cannot tell them apart, so neither can the public.
      const row = await one(
        `UPDATE deal_report_links SET last_viewed_at = $2, view_count = view_count + 1
          WHERE token_sha256 = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
          RETURNING org_id, deal_id`,
        [tokenSha256, now],
      );
      return row ? { orgId: row.org_id as string, dealId: row.deal_id as string } : null;
    },

    async readReport(orgId, dealId) {
      const head = await one(
        `SELECT d.title, sp.name AS sponsor_name FROM deal_deals d
           JOIN deal_sponsors sp ON sp.id = d.sponsor_id AND sp.org_id = d.org_id
          WHERE d.org_id = $1 AND d.id = $2`,
        [orgId, dealId],
      );
      if (!head) return null;
      // Only live bookings that have a delivery; never a price, a note or an id.
      const rows = await many(
        `SELECT p.name AS publication_name, p.kind AS publication_kind, i.title AS issue_title, i.publish_on,
                s.label AS slot_label, b.format, v.delivered_on, v.proof_url, v.opens, v.clicks, v.impressions, v.downloads
           FROM deal_bookings b
           JOIN deal_deliveries v ON v.booking_id = b.id AND v.org_id = b.org_id
           JOIN deal_slots s ON s.id = b.slot_id AND s.org_id = b.org_id
           JOIN deal_issues i ON i.id = s.issue_id AND i.org_id = b.org_id
           JOIN deal_publications p ON p.id = s.publication_id AND p.org_id = b.org_id
          WHERE b.org_id = $1 AND b.deal_id = $2 AND b.released_at IS NULL
          ORDER BY i.publish_on ASC, p.name ASC, s.label ASC`,
        [orgId, dealId],
      );
      const lines = rows.map(
        (r): ReportLine => ({
          publicationName: r.publication_name as string,
          publicationKind: r.publication_kind as string,
          issueTitle: r.issue_title as string,
          publishOn: r.publish_on as string,
          slotLabel: r.slot_label as string,
          format: r.format as string,
          deliveredOn: r.delivered_on as string,
          proofUrl: str(r.proof_url),
          opens: num(r.opens),
          clicks: num(r.clicks),
          impressions: num(r.impressions),
          downloads: num(r.downloads),
        }),
      );
      const report: PublicReport = { sponsorName: head.sponsor_name as string, dealTitle: head.title as string, lines };
      return report;
    },
  };
  return repo;
}
