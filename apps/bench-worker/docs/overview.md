# bench-worker

Rateboard's opt-in rate benchmarks (RB3, epic design §6). Three things:

- **Consent** — `GET|PUT|DELETE /v1/organizations/{org}/benchmark-contribution`, owner or admin only (`bench.contribute`).
- **The aggregate** — `scheduled()`: prod weekly (Mondays 04:00 UTC). Reads contributed bookings through `readContributedBookings`, the one cross-tenant read in the codebase, and writes the published cells.
- **Reads** — `GET …/benchmarks/cells` and `GET …/benchmarks?niche=&band=&format=` (exact keys only), for members of a contributing org (`bench.read`).
