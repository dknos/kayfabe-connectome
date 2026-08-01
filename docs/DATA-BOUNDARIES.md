# Data Boundaries

## Never committed
- `.env`, `.env.local`, any credential
- The source database or any copy/dump of it (`data/private/`)
- WrestlingDB raw response caches (`data/private/wrestlingdb-cache/`)
- Materialized outputs containing full-corpus private data (`data/materialized/`)

## Never sent to the browser
- `WRESTLINGDB_API_KEY` (server-side only; never in Vite env, JS bundles, URLs)
- Database credentials or file paths
- Raw source tables, unbounded joins, arbitrary SQL
- Fields classified `private` in the schema map

## Never fabricated
- Dates, identities, title transfers, employment, retirement, feuds
- When both sources lack a field it is recorded as missing

## Out of scope in v1 (no fetching, no scrapers, no dormant scraper deps)
- CAGEMATCH, WrestlingData, Fandom/Wikis, Wikipedia, general web scraping

## Logging
- All Authorization-like headers redacted
- Database connection strings redacted
- Secret-scanning check runs in the test suite
