# bench-worker — architecture

- Reached only over api-edge's `BENCH_WORKER` service binding (`workers_dev: false`).
- Per cell (niche × audience band × format, 525 disjoint cells), each contributor is reduced to one median; a cell publishes only with k = 5 independent contributors (orgs sharing an owner or admin merge), as p25/p50/p75 rounded to two significant figures and a contributor band.
- A new version of a cell is withheld when its member set differs from ANY published version of that cell by exactly one org. Members are kept as SHA-256 pseudonyms in `bench_cell_contributors`, which no route reads.
- A run writes its cells first and marks itself done last; reads serve the latest done snapshot, so a failed run leaves the previous one serving.
