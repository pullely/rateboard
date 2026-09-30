# bench-worker-tests — overview

The eight tests of epic design §6.7 for `apps/bench-worker`, on a real SQLite
engine (`node:sqlite`) with every migration applied: threshold, no rows,
dominance, query differencing, snapshot differencing and revocation, the
recovery attempt, consent, and the static boundary test.
