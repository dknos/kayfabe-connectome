# THE BOOK — Release Checklist

Status keys: ✅ done · 🔶 partial · ⬜ not started. Updated 2026-08-07.

## Every release

- ✅ `pnpm --filter @kayfabe/sim-core test` (99)
- ✅ `pnpm --filter @kayfabe/history-adapter test` (15, incl. real-corpus build)
- ✅ `npx playwright test -c apps/simulator/playwright.config.ts` (vertical-slice E2E)
- ✅ Strict typecheck all packages (`tsc --noEmit` ×3, `tsc -b` app)
- ✅ `npx vite build` production bundle
- ✅ Benchmark numbers recorded in PERFORMANCE.md with hardware
- ✅ PROGRESS.md reflects reality (no aspirational claims)
- ✅ No secrets, no `data/private`, no corpus files, no real-person imagery staged
  (`git status` review before commit; data/ is symlinked and gitignored)
- ✅ Screenshot walk (`--grep screenshots`) eyeballed

## Before a public/shipped build (Phase 6 — not yet)

- ⬜ Electron shell, SQLite SaveStore, installer builds
- ⬜ Save-migration test matrix across schema versions
- ⬜ Crash recovery + autosave cadence
- ⬜ Onboarding/contextual help pass
- ⬜ Accessibility gap list (ACCESSIBILITY.md) closed
- ⬜ Viewport matrix: 1366×768 / 1440×900 / 2560×1440 / 32:9 in CI
- ⬜ Sample scenario + modding documentation for end users
- ⬜ License/attribution review (corpus provenance is profightdb-scraped private data —
  **the corpus must never ship with a distributed build**; a distributable data story is
  a prerequisite to any release)
