# bench-worker — runbook

- Run totals: `SELECT * FROM bench_runs ORDER BY started_at DESC` (operator only; never served).
- A stuck `running` row is a run that died; the previous snapshot keeps serving and the next cron retries.
- `BENCH_MIN_OPTIN_DAYS` is a STAGE-ONLY override of the 30-day opt-in age. It must never appear in the prod vars; the code ignores it when `ENVIRONMENT` is `prod`.
