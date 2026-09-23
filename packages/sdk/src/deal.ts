import type {
  BookingResponse,
  CreateBookingRequest,
  CreateDealRequest,
  CreateIssueRequest,
  CreatePublicationRequest,
  CreateSlotRequest,
  CreateSponsorRequest,
  DealResponse,
  GetDealResponse,
  GetSponsorResponse,
  InventoryResponse,
  IssueResponse,
  ListDealsResponse,
  ListPublicationsResponse,
  ListSponsorsResponse,
  MoveDealStageRequest,
  PipelineResponse,
  PublicationResponse,
  SlotResponse,
  SponsorResponse,
  UpdateDealRequest,
  UpdatePublicationRequest,
  UpdateSponsorRequest,
} from "@saas/contracts/deal";

import type { RequestOptions, Transport } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}`;
const seg = (id: string): string => encodeURIComponent(id);

/**
 * Rateboard deals client — publications, issues and ad slots, the inventory
 * calendar, sponsors, deals through the pipeline and their bookings.
 * Org-scoped; maps to `apps/deal-worker` through the api-edge deal facade.
 * A second booking of a slot is refused with 409 (`details.reason =
 * "slot_already_booked"`).
 */
export class DealClient {
  constructor(private readonly transport: Transport) {}

  listPublications(orgId: string, query: { status?: string } = {}, opts: RequestOptions = {}): Promise<ListPublicationsResponse> {
    return this.transport.request<ListPublicationsResponse>({ method: "GET", path: `${org(orgId)}/publications`, query }, opts);
  }

  createPublication(orgId: string, body: CreatePublicationRequest, opts: RequestOptions = {}): Promise<PublicationResponse> {
    return this.transport.request<PublicationResponse>({ method: "POST", path: `${org(orgId)}/publications`, body }, opts);
  }

  getPublication(orgId: string, publicationId: string, opts: RequestOptions = {}): Promise<PublicationResponse> {
    return this.transport.request<PublicationResponse>({ method: "GET", path: `${org(orgId)}/publications/${seg(publicationId)}` }, opts);
  }

  updatePublication(orgId: string, publicationId: string, body: UpdatePublicationRequest, opts: RequestOptions = {}): Promise<PublicationResponse> {
    return this.transport.request<PublicationResponse>(
      { method: "PATCH", path: `${org(orgId)}/publications/${seg(publicationId)}`, body },
      opts,
    );
  }

  /** POST …/publications/:id/issues — an issue or episode, optionally with its slots. */
  createIssue(orgId: string, publicationId: string, body: CreateIssueRequest, opts: RequestOptions = {}): Promise<IssueResponse> {
    return this.transport.request<IssueResponse>(
      { method: "POST", path: `${org(orgId)}/publications/${seg(publicationId)}/issues`, body },
      opts,
    );
  }

  createSlot(orgId: string, issueId: string, body: CreateSlotRequest, opts: RequestOptions = {}): Promise<SlotResponse> {
    return this.transport.request<SlotResponse>({ method: "POST", path: `${org(orgId)}/issues/${seg(issueId)}/slots`, body }, opts);
  }

  /** GET …/inventory — issues in [from, to] with each slot's live booking. */
  inventory(orgId: string, query: { from?: string; to?: string; publication?: string } = {}, opts: RequestOptions = {}): Promise<InventoryResponse> {
    return this.transport.request<InventoryResponse>({ method: "GET", path: `${org(orgId)}/inventory`, query }, opts);
  }

  listSponsors(orgId: string, opts: RequestOptions = {}): Promise<ListSponsorsResponse> {
    return this.transport.request<ListSponsorsResponse>({ method: "GET", path: `${org(orgId)}/sponsors` }, opts);
  }

  createSponsor(orgId: string, body: CreateSponsorRequest, opts: RequestOptions = {}): Promise<SponsorResponse> {
    return this.transport.request<SponsorResponse>({ method: "POST", path: `${org(orgId)}/sponsors`, body }, opts);
  }

  getSponsor(orgId: string, sponsorId: string, opts: RequestOptions = {}): Promise<GetSponsorResponse> {
    return this.transport.request<GetSponsorResponse>({ method: "GET", path: `${org(orgId)}/sponsors/${seg(sponsorId)}` }, opts);
  }

  updateSponsor(orgId: string, sponsorId: string, body: UpdateSponsorRequest, opts: RequestOptions = {}): Promise<SponsorResponse> {
    return this.transport.request<SponsorResponse>({ method: "PATCH", path: `${org(orgId)}/sponsors/${seg(sponsorId)}`, body }, opts);
  }

  listDeals(orgId: string, query: { stage?: string } = {}, opts: RequestOptions = {}): Promise<ListDealsResponse> {
    return this.transport.request<ListDealsResponse>({ method: "GET", path: `${org(orgId)}/deals`, query }, opts);
  }

  createDeal(orgId: string, body: CreateDealRequest, opts: RequestOptions = {}): Promise<DealResponse> {
    return this.transport.request<DealResponse>({ method: "POST", path: `${org(orgId)}/deals`, body }, opts);
  }

  /** GET …/deals/:id — the deal with its bookings and stage history. */
  getDeal(orgId: string, dealId: string, opts: RequestOptions = {}): Promise<GetDealResponse> {
    return this.transport.request<GetDealResponse>({ method: "GET", path: `${org(orgId)}/deals/${seg(dealId)}` }, opts);
  }

  updateDeal(orgId: string, dealId: string, body: UpdateDealRequest, opts: RequestOptions = {}): Promise<DealResponse> {
    return this.transport.request<DealResponse>({ method: "PATCH", path: `${org(orgId)}/deals/${seg(dealId)}`, body }, opts);
  }

  /** POST …/deals/:id/stage — 409 `stage_conflict` / `no_bookings`, 422 for a move the pipeline does not allow. */
  moveStage(orgId: string, dealId: string, body: MoveDealStageRequest, opts: RequestOptions = {}): Promise<DealResponse> {
    return this.transport.request<DealResponse>({ method: "POST", path: `${org(orgId)}/deals/${seg(dealId)}/stage`, body }, opts);
  }

  /** POST …/deals/:id/bookings — 409 `slot_already_booked` when the slot is taken. */
  book(orgId: string, dealId: string, body: CreateBookingRequest, opts: RequestOptions = {}): Promise<BookingResponse> {
    return this.transport.request<BookingResponse>({ method: "POST", path: `${org(orgId)}/deals/${seg(dealId)}/bookings`, body }, opts);
  }

  release(orgId: string, dealId: string, bookingId: string, opts: RequestOptions = {}): Promise<BookingResponse> {
    return this.transport.request<BookingResponse>(
      { method: "DELETE", path: `${org(orgId)}/deals/${seg(dealId)}/bookings/${seg(bookingId)}` },
      opts,
    );
  }

  pipeline(orgId: string, opts: RequestOptions = {}): Promise<PipelineResponse> {
    return this.transport.request<PipelineResponse>({ method: "GET", path: `${org(orgId)}/pipeline` }, opts);
  }
}
