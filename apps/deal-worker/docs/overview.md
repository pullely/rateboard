# deal-worker — overview

Owns the `deal` bounded context: Rateboard's **sponsor pipeline**. A creator's
publications (newsletters and podcasts, each with a niche and a hand-entered
audience size), their dated issues or episodes, the ad slots in each, the
sponsor book, the deals that move lead → pitched → booked → delivered → paid
(or lost), and the **bookings** of deals into slots. RB2 adds insertion
orders, proof of delivery and the sponsor report link.

The invariants this worker holds:

- **a slot has at most one live booking.** The partial unique index
  `uq_deal_bookings_live_slot` enforces it in D1, and a booking is claimed in
  one `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` statement. A
  second claim is `409 slot_already_booked`, however many arrive at once.
- a stage moves only along the state machine in `@saas/contracts/deal`
  (`DEAL_TRANSITIONS`), by one conditional `UPDATE … WHERE stage = $from
  RETURNING`. `booked` needs a live booking. A booked deal keeps at least one.
- every query is scoped by `org_id`. A non-member gets 404, never 403.
- a booking copies the slot's format and the publication's niche and audience
  size at booking time. That is what RB3's benchmark aggregates, and no one
  may rewrite it.

## What it serves

All under `/v1/organizations/{org}/`: `publications`, `publications/{rbp}`,
`publications/{rbp}/issues`, `issues/{rbi}/slots`, `inventory`, `sponsors`,
`sponsors/{rbn}`, `deals`, `deals/{rbd}`, `deals/{rbd}/stage`,
`deals/{rbd}/bookings`, `deals/{rbd}/bookings/{rbb}`, `pipeline`. Reads need
`deal.read` (every role). Writes need `deal.write` (owner, admin, builder).
