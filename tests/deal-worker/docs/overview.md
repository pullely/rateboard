# deal-worker-tests — overview

Tests for `apps/deal-worker` on a real SQLite engine (`node:sqlite`) with every
migration applied, so the partial unique index, the conditional statements
and the audit writes are the ones D1 runs. Covers the pipeline state machine
(including a lost race between two moves), the double-booking guarantee
(sequential, a 12-way concurrent race with exactly one winner, and raw SQL
that bypasses the worker), the release rules, validation, the tenant boundary
(404 for non-members and other orgs' owners), and the trap-22 `rowCount` pins.
