# THE BOOK — Performance

All numbers measured on the development machine, 2026-08-07:
AMD Ryzen 9 9950X (8 vCPUs exposed under WSL2), 43 GB RAM, NVMe, Linux 6.6 (WSL2),
Node 22 / pnpm 10.33.

| Workload | Measured | Where |
|---|---|---|
| One simulated year, headless (fixture: 3 companies, 34 workers, 2 AI schedulers) | **1.6 s** (4.4 ms/day), 64 shows, 1,933 transactions | `sim-core/test/benchmark.test.ts` (in CI suite; asserts < 60 s ceiling) |
| Real-corpus snapshot build at 1997-01-06 (node, warm FS) | **≈1.4 s** — 397 workers across 3 full + abstract companies, 77 titles, 35 venues | `history-adapter/test/snapshot-real.test.ts` |
| Full E2E journey incl. browser, wizard build, show, 30 days, save/reload | **12.6 s** | `apps/simulator/e2e/vertical-slice.spec.ts` |
| Production bundle | 352 KB JS (108 KB gzip), CSS 7 KB | `npx vite build` |
| Full unit+integration suites | ~3.5 s combined | vitest |

## Budget discipline (what keeps it fast)

- **No full-corpus loads.** Eager reads are `search/entities.json` + promotions +
  manifest; everything else is per-shard (`fnv1a32 % 256`) or per-year, cached.
- Snapshot keeps only sim-relevant extracts; the 700 MB corpus never enters app state.
- Engine state is plain JSON data; day advancement is O(companies + due shows) with
  sorted-key iteration; `structuredClone` per command measured negligible at slice scale.
- Virtualization not yet needed: rosters cap at 80/company by design; the ledger and
  wire cap rendered rows (200/300) with counts.

## Known costs to watch as scope grows

- `stateHash` walks the full state; at slice scale it is sub-millisecond-to-few-ms, but
  hashing after every command would not scale to 100+ detailed companies — hash on
  save/verify only (current behavior; Settings recomputes on render).
- The Almanac's person search scans 30k names in memory (instant after the eager entity
  load); a prefix index is the upgrade path if search feel degrades.
- Moving the engine into a Web Worker is architected for (DOM-free sim-core, async-ready
  store) and becomes necessary only when abstract-tier company counts grow by an order
  of magnitude.
