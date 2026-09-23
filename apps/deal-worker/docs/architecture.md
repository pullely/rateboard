# deal-worker — architecture

```
creator ──► api-edge ──(resolveActor)──► deal-worker ──► D1 (deal_*, events_*)
                                                      ├─► membership-worker (context)
                                                      └─► policy-worker (authorize)
```

- Reachable only over the `DEAL_WORKER` service binding (`workers_dev: false`).
- Every route runs membership authorization-context, then policy authorize. A
  deny is `404`, never `403`.
- `packages/db/src/deal` is the only SQL. Every write the caller branches on
  reports through `RETURNING` rows, never `rowCount` (runbook trap 22). The
  booking claim, the release and the stage move are each one conditional
  statement, because D1 has no interactive transactions.
- Audit rows are written with portable SQL (`appendEvent` + `INSERT …
  SELECT`), best-effort after the write they describe has committed. A
  refused double-booking is audited too (`deal.booking.refused`).
- Depends on `db-migrate`, so a run that adds a `deal_*` migration applies it
  before this worker's code that reads it goes live (runbook trap 21).
