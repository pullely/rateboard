import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  Booking,
  ClaimBookingInput,
  ClaimContext,
  Deal,
  DealFields,
  DealRepository,
  Issue,
  MoveStageInput,
  Publication,
  PublicationFields,
  Slot,
  SlotFields,
  Sponsor,
  SponsorFields,
  StageChange,
  StageSummaryRow,
} from "./types.js";

type Row = SqlRow & Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapPublication(row: Row): Publication {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    kind: row.kind as string,
    niche: row.niche as string,
    audienceSize: Number(row.audience_size),
    platform: str(row.platform),
    currency: row.currency as string,
    status: row.status as string,
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapIssue(row: Row): Issue {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    publicationId: row.publication_id as string,
    publicationName: row.publication_name as string,
    publicationKind: row.publication_kind as string,
    title: row.title as string,
    publishOn: row.publish_on as string,
    status: row.status as string,
    createdAt: row.created_at as string,
  };
}

function mapSlot(row: Row): Slot {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    issueId: row.issue_id as string,
    publicationId: row.publication_id as string,
    label: row.label as string,
    format: row.format as string,
    listPriceCents: num(row.list_price_cents),
    currency: row.currency as string,
    createdAt: row.created_at as string,
    booking:
      row.booking_id === null || row.booking_id === undefined
        ? null
        : {
            id: row.booking_id as string,
            dealId: row.booking_deal_id as string,
            dealTitle: row.booking_deal_title as string,
            dealStage: row.booking_deal_stage as string,
            sponsorId: row.booking_sponsor_id as string,
            sponsorName: row.booking_sponsor_name as string,
            priceCents: Number(row.booking_price_cents),
            currency: row.booking_currency as string,
          },
  };
}

function mapSponsor(row: Row): Sponsor {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    website: str(row.website),
    contactName: str(row.contact_name),
    contactEmail: str(row.contact_email),
    notes: (row.notes as string) ?? "",
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDeal(row: Row): Deal {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    sponsorId: row.sponsor_id as string,
    sponsorName: row.sponsor_name as string,
    title: row.title as string,
    stage: row.stage as string,
    valueCents: num(row.value_cents),
    currency: row.currency as string,
    pricing: row.pricing as string,
    cpmCents: num(row.cpm_cents),
    notes: (row.notes as string) ?? "",
    liveBookings: Number(row.live_bookings ?? 0),
    stageChangedAt: row.stage_changed_at as string,
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapBooking(row: Row): Booking {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    dealId: row.deal_id as string,
    slotId: row.slot_id as string,
    slotLabel: row.slot_label as string,
    issueId: row.issue_id as string,
    issueTitle: row.issue_title as string,
    publishOn: row.publish_on as string,
    publicationId: row.publication_id as string,
    publicationName: row.publication_name as string,
    format: row.format as string,
    niche: row.niche as string,
    audienceSize: Number(row.audience_size),
    priceCents: Number(row.price_cents),
    currency: row.currency as string,
    bookedBy: str(row.booked_by),
    bookedAt: row.booked_at as string,
    releasedAt: str(row.released_at),
    releaseReason: str(row.release_reason),
  };
}

const PUBLICATION_COLUMNS = `id, org_id, name, kind, niche, audience_size, platform, currency, status,
  created_by, created_at, updated_at`;

const SPONSOR_COLUMNS = `id, org_id, name, website, contact_name, contact_email, notes,
  created_by, created_at, updated_at`;

const ISSUE_SELECT = `SELECT i.id, i.org_id, i.publication_id, i.title, i.publish_on, i.status, i.created_at,
         p.name AS publication_name, p.kind AS publication_kind
    FROM deal_issues i
    JOIN deal_publications p ON p.id = i.publication_id AND p.org_id = i.org_id`;

// A slot with its live booking (if any), the booking's deal and that deal's sponsor.
const SLOT_SELECT = `SELECT s.id, s.org_id, s.issue_id, s.publication_id, s.label, s.format,
         s.list_price_cents, s.currency, s.created_at,
         b.id AS booking_id, b.deal_id AS booking_deal_id, b.price_cents AS booking_price_cents,
         b.currency AS booking_currency, d.title AS booking_deal_title, d.stage AS booking_deal_stage,
         d.sponsor_id AS booking_sponsor_id, sp.name AS booking_sponsor_name
    FROM deal_slots s
    LEFT JOIN deal_bookings b ON b.slot_id = s.id AND b.org_id = s.org_id AND b.released_at IS NULL
    LEFT JOIN deal_deals d ON d.id = b.deal_id AND d.org_id = s.org_id
    LEFT JOIN deal_sponsors sp ON sp.id = d.sponsor_id AND sp.org_id = s.org_id`;

const DEAL_SELECT = `SELECT d.id, d.org_id, d.sponsor_id, d.title, d.stage, d.value_cents, d.currency, d.pricing,
         d.cpm_cents, d.notes, d.stage_changed_at, d.created_by, d.created_at, d.updated_at,
         sp.name AS sponsor_name,
         (SELECT COUNT(*) FROM deal_bookings b
           WHERE b.deal_id = d.id AND b.org_id = d.org_id AND b.released_at IS NULL) AS live_bookings
    FROM deal_deals d
    JOIN deal_sponsors sp ON sp.id = d.sponsor_id AND sp.org_id = d.org_id`;

const BOOKING_SELECT = `SELECT b.id, b.org_id, b.deal_id, b.slot_id, b.price_cents, b.currency, b.format, b.niche,
         b.audience_size, b.booked_by, b.booked_at, b.released_at, b.release_reason,
         s.label AS slot_label, s.issue_id, i.title AS issue_title, i.publish_on,
         s.publication_id, p.name AS publication_name
    FROM deal_bookings b
    JOIN deal_slots s ON s.id = b.slot_id AND s.org_id = b.org_id
    JOIN deal_issues i ON i.id = s.issue_id AND i.org_id = b.org_id
    JOIN deal_publications p ON p.id = s.publication_id AND p.org_id = b.org_id`;

export function createDealRepository(executor: SqlExecutor): DealRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }
  async function many(sql: string, params: unknown[]): Promise<Row[]> {
    return (await executor.execute<Row>(sql, params)).rows;
  }

  const repo: DealRepository = {
    // ── publications ─────────────────────────────────────────
    async createPublication(input) {
      // ON CONFLICT DO NOTHING: a duplicate name (per org, case-insensitive)
      // inserts nothing and returns no row — the caller answers 409.
      const row = await one(
        `INSERT INTO deal_publications
           (id, org_id, name, kind, niche, audience_size, platform, currency, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT DO NOTHING
         RETURNING ${PUBLICATION_COLUMNS}`,
        [input.id, input.orgId, input.name, input.kind, input.niche, input.audienceSize, input.platform,
          input.currency, input.status, input.createdBy, input.now],
      );
      return row ? mapPublication(row) : null;
    },

    async getPublication(orgId, id) {
      const row = await one(`SELECT ${PUBLICATION_COLUMNS} FROM deal_publications WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return row ? mapPublication(row) : null;
    },

    async listPublications(orgId, status) {
      const params: unknown[] = [orgId];
      let where = "org_id = $1";
      if (status) {
        params.push(status);
        where += " AND status = $2";
      }
      const rows = await many(`SELECT ${PUBLICATION_COLUMNS} FROM deal_publications WHERE ${where} ORDER BY name ASC LIMIT 200`, params);
      return rows.map(mapPublication);
    },

    async updatePublication(orgId, id, f: PublicationFields, now) {
      // OR IGNORE: a rename onto another publication's name changes nothing and
      // returns no row, like an absent id. The handler has read the row first,
      // so it can tell the two apart.
      const row = await one(
        `UPDATE OR IGNORE deal_publications SET
           name = $3, kind = $4, niche = $5, audience_size = $6, platform = $7, currency = $8,
           status = $9, updated_at = $10
         WHERE org_id = $1 AND id = $2
         RETURNING ${PUBLICATION_COLUMNS}`,
        [orgId, id, f.name, f.kind, f.niche, f.audienceSize, f.platform, f.currency, f.status, now],
      );
      return row ? mapPublication(row) : null;
    },

    // ── issues and slots ─────────────────────────────────────
    async createIssue(input) {
      const row = await one(
        `INSERT INTO deal_issues (id, org_id, publication_id, title, publish_on, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.id, input.orgId, input.publicationId, input.title, input.publishOn, input.createdBy, input.now],
      );
      return row ? repo.getIssue(input.orgId, input.id) : null;
    },

    async getIssue(orgId, id) {
      const row = await one(`${ISSUE_SELECT} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id]);
      return row ? mapIssue(row) : null;
    },

    async createSlot(input) {
      const row = await one(
        `INSERT INTO deal_slots
           (id, org_id, issue_id, publication_id, label, format, list_price_cents, currency, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.id, input.orgId, input.issueId, input.publicationId, input.label, input.format,
          input.listPriceCents, input.currency, input.createdBy, input.now],
      );
      return row ? repo.getSlot(input.orgId, input.id) : null;
    },

    async getSlot(orgId, id) {
      const row = await one(`${SLOT_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
      return row ? mapSlot(row) : null;
    },

    async listSlotsForIssue(orgId, issueId) {
      const rows = await many(`${SLOT_SELECT} WHERE s.org_id = $1 AND s.issue_id = $2 ORDER BY s.created_at ASC, s.id ASC`, [orgId, issueId]);
      return rows.map(mapSlot);
    },

    async listIssuesInRange(orgId, from, to, publicationId) {
      const params: unknown[] = [orgId, from, to];
      let where = "i.org_id = $1 AND i.publish_on >= $2 AND i.publish_on <= $3";
      if (publicationId) {
        params.push(publicationId);
        where += " AND i.publication_id = $4";
      }
      const rows = await many(`${ISSUE_SELECT} WHERE ${where} ORDER BY i.publish_on ASC, p.name ASC, i.title ASC LIMIT 500`, params);
      return rows.map(mapIssue);
    },

    async listSlotsInRange(orgId, from, to, publicationId) {
      const params: unknown[] = [orgId, from, to];
      let where = "s.org_id = $1 AND i.publish_on >= $2 AND i.publish_on <= $3";
      if (publicationId) {
        params.push(publicationId);
        where += " AND s.publication_id = $4";
      }
      const rows = await many(
        `${SLOT_SELECT.replace("FROM deal_slots s", "FROM deal_slots s\n    JOIN deal_issues i ON i.id = s.issue_id AND i.org_id = s.org_id")}
          WHERE ${where} ORDER BY s.created_at ASC, s.id ASC LIMIT 5000`,
        params,
      );
      return rows.map(mapSlot);
    },

    // ── sponsors ─────────────────────────────────────────────
    async createSponsor(input) {
      const row = await one(
        `INSERT INTO deal_sponsors
           (id, org_id, name, website, contact_name, contact_email, notes, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT DO NOTHING
         RETURNING ${SPONSOR_COLUMNS}`,
        [input.id, input.orgId, input.name, input.website, input.contactName, input.contactEmail, input.notes,
          input.createdBy, input.now],
      );
      return row ? mapSponsor(row) : null;
    },

    async getSponsor(orgId, id) {
      const row = await one(`SELECT ${SPONSOR_COLUMNS} FROM deal_sponsors WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return row ? mapSponsor(row) : null;
    },

    async findSponsorByName(orgId, name) {
      // name is COLLATE NOCASE, so = is a case-insensitive match.
      const row = await one(`SELECT ${SPONSOR_COLUMNS} FROM deal_sponsors WHERE org_id = $1 AND name = $2`, [orgId, name]);
      return row ? mapSponsor(row) : null;
    },

    async listSponsors(orgId) {
      const rows = await many(`SELECT ${SPONSOR_COLUMNS} FROM deal_sponsors WHERE org_id = $1 ORDER BY name ASC LIMIT 1000`, [orgId]);
      return rows.map(mapSponsor);
    },

    async updateSponsor(orgId, id, f: SponsorFields, now) {
      const row = await one(
        `UPDATE OR IGNORE deal_sponsors SET
           name = $3, website = $4, contact_name = $5, contact_email = $6, notes = $7, updated_at = $8
         WHERE org_id = $1 AND id = $2
         RETURNING ${SPONSOR_COLUMNS}`,
        [orgId, id, f.name, f.website, f.contactName, f.contactEmail, f.notes, now],
      );
      return row ? mapSponsor(row) : null;
    },

    // ── deals ────────────────────────────────────────────────
    async createDeal(input) {
      const row = await one(
        `INSERT INTO deal_deals
           (id, org_id, sponsor_id, title, stage, value_cents, currency, pricing, cpm_cents, notes,
            stage_changed_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'lead', $5, $6, $7, $8, $9, $10, $11, $10, $10)
         RETURNING id`,
        [input.id, input.orgId, input.sponsorId, input.title, input.valueCents, input.currency, input.pricing,
          input.cpmCents, input.notes, input.now, input.createdBy],
      );
      if (!row) throw new Error("deal: insert returned no row");
      const deal = await repo.getDeal(input.orgId, input.id);
      if (!deal) throw new Error("deal: inserted row not readable");
      return deal;
    },

    async getDeal(orgId, id) {
      const row = await one(`${DEAL_SELECT} WHERE d.org_id = $1 AND d.id = $2`, [orgId, id]);
      return row ? mapDeal(row) : null;
    },

    async listDeals(orgId, filter) {
      const params: unknown[] = [orgId];
      let where = "d.org_id = $1";
      if (filter.stage) {
        params.push(filter.stage);
        where += ` AND d.stage = $${params.length}`;
      }
      if (filter.sponsorId) {
        params.push(filter.sponsorId);
        where += ` AND d.sponsor_id = $${params.length}`;
      }
      const rows = await many(`${DEAL_SELECT} WHERE ${where} ORDER BY d.stage_changed_at DESC, d.id DESC LIMIT 500`, params);
      return rows.map(mapDeal);
    },

    async updateDeal(orgId, id, f: DealFields, now) {
      const row = await one(
        `UPDATE deal_deals SET
           title = $3, value_cents = $4, currency = $5, pricing = $6, cpm_cents = $7, notes = $8, updated_at = $9
         WHERE org_id = $1 AND id = $2
         RETURNING id`,
        [orgId, id, f.title, f.valueCents, f.currency, f.pricing, f.cpmCents, f.notes, now],
      );
      return row ? repo.getDeal(orgId, id) : null;
    },

    async moveStage(input: MoveStageInput) {
      // One conditional statement: two concurrent moves of the same deal cannot
      // both match `stage = $from`. `booked` also needs a live booking, checked
      // in the same WHERE so a release racing the move cannot slip between.
      const liveBooking = input.requireLiveBooking
        ? ` AND EXISTS (SELECT 1 FROM deal_bookings b
                         WHERE b.deal_id = deal_deals.id AND b.org_id = deal_deals.org_id AND b.released_at IS NULL)`
        : "";
      const row = await one(
        `UPDATE deal_deals SET stage = $4, stage_changed_at = $5, updated_at = $5
          WHERE org_id = $1 AND id = $2 AND stage = $3${liveBooking}
          RETURNING id`,
        [input.orgId, input.dealId, input.from, input.to, input.now],
      );
      return row ? repo.getDeal(input.orgId, input.dealId) : null;
    },

    async appendStageHistory(input) {
      await executor.execute(
        `INSERT INTO deal_stage_history (id, org_id, deal_id, from_stage, to_stage, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.id, input.orgId, input.dealId, input.fromStage, input.toStage, input.changedBy, input.now],
      );
    },

    async listStageHistory(orgId, dealId) {
      const rows = await many(
        `SELECT id, deal_id, from_stage, to_stage, changed_by, changed_at FROM deal_stage_history
          WHERE org_id = $1 AND deal_id = $2 ORDER BY changed_at ASC, rowid ASC`,
        [orgId, dealId],
      );
      return rows.map(
        (row): StageChange => ({
          id: row.id as string,
          dealId: row.deal_id as string,
          fromStage: str(row.from_stage),
          toStage: row.to_stage as string,
          changedBy: str(row.changed_by),
          changedAt: row.changed_at as string,
        }),
      );
    },

    async pipelineSummary(orgId) {
      const rows = await many(
        `SELECT stage, currency, COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS total
           FROM deal_deals WHERE org_id = $1 GROUP BY stage, currency`,
        [orgId],
      );
      return rows.map(
        (row): StageSummaryRow => ({
          stage: row.stage as string,
          currency: row.currency as string,
          count: Number(row.n),
          valueCents: Number(row.total),
        }),
      );
    },

    // ── bookings ─────────────────────────────────────────────
    async claimBooking(input: ClaimBookingInput) {
      // THE double-booking guarantee (design §2). Everything the claim depends
      // on is in this one statement; the partial unique index
      // uq_deal_bookings_live_slot refuses a second live booking of the slot,
      // and ON CONFLICT DO NOTHING turns that refusal into "no row returned".
      // Decided from RETURNING rows, never rowCount (trap 22).
      const row = await one(
        `INSERT INTO deal_bookings
           (id, org_id, deal_id, slot_id, price_cents, currency, format, niche, audience_size, booked_by, booked_at)
         SELECT $1, d.org_id, d.id, s.id, COALESCE($5, s.list_price_cents), s.currency, s.format, p.niche,
                p.audience_size, $6, $7
           FROM deal_deals d
           JOIN deal_slots s ON s.id = $4 AND s.org_id = d.org_id
           JOIN deal_issues i ON i.id = s.issue_id AND i.org_id = d.org_id AND i.status <> 'cancelled'
           JOIN deal_publications p ON p.id = s.publication_id AND p.org_id = d.org_id
          WHERE d.id = $3 AND d.org_id = $2
            AND d.stage IN ('lead', 'pitched', 'booked')
            AND COALESCE($5, s.list_price_cents) IS NOT NULL
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.id, input.orgId, input.dealId, input.slotId, input.priceCents, input.bookedBy, input.now],
      );
      return row ? (row.id as string) : null;
    },

    async claimContext(orgId, dealId, slotId) {
      const deal = await one(`SELECT stage FROM deal_deals WHERE org_id = $1 AND id = $2`, [orgId, dealId]);
      const slot = await one(
        `SELECT s.id, i.status AS issue_status,
                (SELECT b.id FROM deal_bookings b WHERE b.slot_id = s.id AND b.released_at IS NULL) AS live_id,
                (SELECT b.deal_id FROM deal_bookings b WHERE b.slot_id = s.id AND b.released_at IS NULL) AS live_deal_id
           FROM deal_slots s JOIN deal_issues i ON i.id = s.issue_id
          WHERE s.org_id = $1 AND s.id = $2`,
        [orgId, slotId],
      );
      return {
        dealStage: deal ? (deal.stage as string) : null,
        slotExists: slot !== null,
        issueStatus: slot ? (slot.issue_status as string) : null,
        liveBooking: slot && slot.live_id ? { id: slot.live_id as string, dealId: slot.live_deal_id as string } : null,
      } satisfies ClaimContext;
    },

    async getBooking(orgId, id) {
      const row = await one(`${BOOKING_SELECT} WHERE b.org_id = $1 AND b.id = $2`, [orgId, id]);
      return row ? mapBooking(row) : null;
    },

    async listBookingsForDeal(orgId, dealId) {
      const rows = await many(
        `${BOOKING_SELECT} WHERE b.org_id = $1 AND b.deal_id = $2
          ORDER BY (b.released_at IS NULL) DESC, i.publish_on ASC, b.booked_at ASC`,
        [orgId, dealId],
      );
      return rows.map(mapBooking);
    },

    async releaseBooking(input) {
      // Conditional in one statement: lead/pitched deals release freely; a
      // booked deal keeps at least one live booking, so two concurrent releases
      // of its last two bookings cannot both succeed.
      const row = await one(
        `UPDATE deal_bookings SET released_at = $4, released_by = $5, release_reason = 'released'
          WHERE org_id = $1 AND deal_id = $2 AND id = $3 AND released_at IS NULL
            AND EXISTS (
              SELECT 1 FROM deal_deals d
               WHERE d.id = deal_bookings.deal_id AND d.org_id = deal_bookings.org_id
                 AND (d.stage IN ('lead', 'pitched')
                      OR (d.stage = 'booked'
                          AND (SELECT COUNT(*) FROM deal_bookings o
                                WHERE o.deal_id = d.id AND o.org_id = d.org_id AND o.released_at IS NULL) > 1)))
          RETURNING id`,
        [input.orgId, input.dealId, input.bookingId, input.now, input.releasedBy],
      );
      return row ? repo.getBooking(input.orgId, input.bookingId) : null;
    },

    async releaseAllForDeal(input) {
      const rows = await many(
        `UPDATE deal_bookings SET released_at = $3, released_by = $4, release_reason = 'deal_lost'
          WHERE org_id = $1 AND deal_id = $2 AND released_at IS NULL
          RETURNING id`,
        [input.orgId, input.dealId, input.now, input.releasedBy],
      );
      return rows.map((r) => r.id as string);
    },
  };
  return repo;
}
