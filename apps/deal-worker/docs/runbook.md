# deal-worker — runbook

- **Health:** `GET /health` on the worker (via a service binding) reports which
  bindings are configured: database, membership, policy.
- **Every route answers 404 for a member:** policy-worker is running an old
  action table without `deal.read`/`deal.write`. A change to
  `packages/policy-engine` does not redeploy policy-worker by itself. Touch its
  `component.yaml` and merge (runbook trap 17).
- **Every call answers 503:** migration `200_deal_core` has not been applied in
  that environment. Check the `db-migrate` lane of the deploy run.
- **"That slot is already booked" but the calendar shows it open:** the
  calendar was read before a teammate's booking. Reload. The database is the
  source of truth, and the refusal is on the audit trail as
  `deal.booking.refused`.
- **A lost deal still holds slots:** releasing them after the stage move
  failed (RB-I). Release them from the deal page. Each release is audited.
