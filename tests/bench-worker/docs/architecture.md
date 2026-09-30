# bench-worker-tests — architecture

Jest (ts-jest, ESM). `src/harness.ts` migrates an in-memory SQLite database,
seeds contributing orgs straight into the deal and membership tables, and
stands in for membership-worker and policy-worker. The aggregate is driven
both through `runAggregate` over SQLite and through the pure `computeSnapshot`
(for the property tests).
