# WrestlingDB (OWDB) API Audit

**Audit date:** 2026-07-31
**Method:** Source-code derivation from the open-source OWDB repository, plus exactly ONE unauthenticated live probe (documented below). No authentication was attempted.
**Source repo:** https://github.com/ericrosenberg1/OWDB — branch `main`, latest commit `e53596e67f245b6a89c6cfa05ccb88c792b18dc6` (2026-07-25T19:54:22Z; repo last pushed 2026-07-27).
**Stack (verified from `requirements.txt`):** Django >=5.2,<5.3, djangorestframework >=3.17.1, PostgreSQL, Redis, Celery, Gunicorn, Sentry.

---

## Headline finding: the documented REST API does not exist in the code or on the live site

The README (`README.md` lines 62–82) documents a JWT-based API:

```bash
curl -X POST https://wrestlingdb.org/api/token/ ...   # "Get JWT token"
curl https://wrestlingdb.org/api/wrestlers/ -H "Authorization: Bearer YOUR_TOKEN"
```

**None of this is wired up.** Verified against the code:

1. **No API URL routes.** The root urlconf `owdb_django/urls.py` (85 lines, read in full) contains only HTML page routes, auth pages, admin, and health checks. There is no `path("api/...")` anywhere, no DRF router, no `include()` of any API urlconf.
2. **No DRF views, serializers, or routers anywhere.** GitHub code search across the repo: the string `rest_framework` appears **only** in `owdb_django/settings.py`. There is no `serializers.py` in the file tree, no `APIView`/`ViewSet` subclass, no `TokenObtainPairView`.
3. **No JWT.** `djangorestframework-simplejwt` (or any JWT package) is absent from `requirements.txt`. The DRF settings configure `TokenAuthentication` + `SessionAuthentication` — the README's `Bearer` / `/api/token/` example could not work even if routes existed.
4. **Live confirmation (single probe, below):** `GET https://wrestlingdb.org/api/wrestlers/` returns **404** with Django's default HTML not-found page.

Conclusion: the README API section is aspirational/stale documentation. DRF is installed and configured but **dormant** — zero endpoints are mounted.

---

## Live probe (the one permitted unauthenticated request)

```
GET https://wrestlingdb.org/api/wrestlers/          (2026-08-01T04:15:22 GMT)
HTTP/2 404
content-type: text/html; charset=utf-8
server: cloudflare        cf-cache-status: DYNAMIC
strict-transport-security, x-frame-options: DENY, CSP present
(no rate-limit headers, no Retry-After, no JSON error body)

<!doctype html>... <h1>Not Found</h1><p>The requested resource was not found on this server.</p> ...
```

- Error shape for unknown paths: **Django default 404 HTML page** (DEBUG=False), not JSON.
- Site is fronted by **Cloudflare** (any future scraping/API use will hit Cloudflare in addition to app-level throttles).
- **No rate-limit headers are emitted** — consistent with the code: DRF's stock `AnonRateThrottle`/`UserRateThrottle` emit only `Retry-After` on 429, and no custom header-emitting throttle class exists in the repo.

---

## API root and version

- **API root:** none mounted. README claims `/api/` (`/api/token/`, `/api/wrestlers/`); code and live probe show it does not exist.
- **API version:** none / undetermined (no versioning config, no `/api/v1/`).
- **OpenAPI/schema endpoint:** none. No `drf-spectacular`, `drf-yasg`, or schema URL in `requirements.txt` or `urls.py`.

## Authentication (configured but dormant)

From `owdb_django/settings.py` lines 626–650 (`REST_FRAMEWORK` dict):

| Setting | Value |
|---|---|
| `DEFAULT_AUTHENTICATION_CLASSES` | `rest_framework.authentication.TokenAuthentication`, `rest_framework.authentication.SessionAuthentication` |
| `DEFAULT_PERMISSION_CLASSES` | `rest_framework.permissions.IsAuthenticated` |
| `DEFAULT_RENDERER_CLASSES` | `rest_framework.renderers.JSONRenderer` only |
| `DEFAULT_PARSER_CLASSES` | `rest_framework.parsers.JSONParser` only |

- If endpoints were ever mounted, the scheme would be DRF token auth: header `Authorization: Token <40-hex-char key>` — **not** JWT `Bearer`.
- `rest_framework.authtoken` is in `INSTALLED_APPS` (settings.py line 103), but there is **also** a separate custom `APIKey` model (see below) that nothing in any request path consumes. Two parallel, both-unused key systems.

### The custom APIKey model (`owdb_django/owdbapp/models.py` line 2460)

- Fields: `user` FK, `key` (40 hex chars via `secrets.token_hex(20)`, unique), `name`, `is_paid`, `requests_today`, `requests_total`, `last_used`, `last_reset`, `is_active`, plus `created_at`/`updated_at`.
- Users can create up to **5 keys** via the `/account/` page (`owdb_django/owdbapp/views.py`, `account` view, line ~1040).
- Celery maintenance: `reset_daily_api_limits` (daily counter reset) and `cleanup_inactive_api_keys` (**deletes free-tier keys unused for 90 days**) in `owdb_django/owdbapp/tasks.py`.
- **Internally contradictory limits:** `APIKey.check_rate_limit()` says free = 1,000 requests/**day**, paid = unlimited; the `APIKey.rate_limit` property says free = 100, paid = 1,000. Neither is enforced anywhere — no middleware or view checks these keys on any data route.

## Pagination (configured but dormant)

- `DEFAULT_PAGINATION_CLASS`: `rest_framework.pagination.PageNumberPagination`, `PAGE_SIZE: 100` (settings.py lines 640–641).
- Parameter would be `?page=N` (DRF default). No `page_size` query override, no `max_page_size` configured.
- The HTML list pages use Django's own paginator (`templates/partials/pagination.html`), unrelated to DRF.

## Rate limits — three conflicting stories

| Source | Free/anon | Authenticated | Paid |
|---|---|---|---|
| `settings.py` `DEFAULT_THROTTLE_RATES` (the only enforceable one, and only if endpoints existed) | `anon: 100/hour` | `user: 10000/hour` | (no paid tier exists in throttle config) |
| `README.md` rate-limit table | 100/hr | 1,000/hr | 10,000/hr |
| `APIKey` model methods | 100 or 1,000/day (self-contradictory) | — | 1,000/day or unlimited (self-contradictory) |

Rate-limit headers: **none emitted** (stock DRF throttles; only `Retry-After` on a 429 would appear). Confirmed absent on the live probe response.

## Error shapes

- **Observed (live):** unknown path → `404`, `text/html`, Django default not-found page.
- **From code, hypothetical if DRF were mounted:** stock DRF JSON errors `{"detail": "..."}` for 401/403/404/429 (`429` with `Retry-After`). No custom exception handler is configured.
- Nothing else can be stated without guessing; anything beyond the above is **undetermined**.

## Resources / endpoints

**REST endpoints: none.** The only machine-accessible surfaces on the live site are:

| Path | What | Format |
|---|---|---|
| `/health/` | Container health check (`views.health_check`) | undetermined from code read (cheap check) |
| `/health/ready/` | Deep readiness check (`views.health_ready`) | undetermined |

**HTML page routes** (from `owdb_django/urls.py` — the de-facto read surface; every entity resolves by integer `pk` **or** unique `slug`):

| Entity | List | Detail |
|---|---|---|
| Wrestlers | `/wrestlers/` | `/wrestlers/<int:pk>/`, `/wrestlers/<slug>/` |
| Promotions | `/promotions/` | `/promotions/<pk>/`, `/promotions/<slug>/` |
| Events | `/events/` | `/events/<pk>/`, `/events/<slug>/` |
| Matches | `/matches/`, `/top/matches/` | `/matches/<int:pk>/` (no slug — Match has no slug field) |
| Titles (championships) | `/titles/` | `/titles/<pk>/`, `/titles/<slug>/` |
| Venues | `/venues/` | `/venues/<pk>/`, `/venues/<slug>/` |
| Stables | `/stables/` | `/stables/<pk>/`, `/stables/<slug>/` |
| Video games / podcasts / episodes / books / specials / hot100 | `/games/`, `/podcasts/`, `/episodes/<pk>/`, `/books/`, `/specials/`, `/hot100/` | pk + slug variants |

## Entity model fields (from `owdb_django/owdbapp/models.py`)

No serializers exist, so **API field names are undetermined**; the model fields below are the authoritative shape.

**Common to all main entities** (abstract bases, models.py lines 30–139):
- `TimeStampedModel`: `created_at` (auto_now_add), **`updated_at`** (auto_now) — the update-timestamp field.
- `VerificationMixin`: `verification_state` ∈ `candidate | provisional | verified | rejected`.
- `ImageMixin` (all but Match): `image_url` (R2 CDN, images.wrestlingdb.org), `image_source_url`, `image_original_url`, `image_license` ∈ `cc0|cc-by|cc-by-sa|pd`, `image_credit` (attribution text), `image_fetched_at`.
- Identifier fields: implicit integer `id` pk + unique `slug` (auto-generated in `save()`); Match has `id` only.

**Wrestler** (line 658): `name`, `slug`, `real_name`, `aliases` (comma-separated text), `debut_year`, `retirement_year`, `hometown`, `nationality`, `finishers`, `about`, `birth_date`, `death_date`, `height`, `weight`, `trained_by`, `signature_moves`, `roles`; source links `wikipedia_url`, `cagematch_url`, `profightdb_url`; verification `verified`, `verification_source`, `last_verified`, `last_enriched`.

**Promotion** (line 314): `name`, `slug`, `abbreviation`, `nicknames`, `founded_year`, `closed_year`, `website`, `about`, `headquarters`, `founder`; source links `wikipedia_url`, `cagematch_url`, `profightdb_url`; `verified`, `verification_source`, `last_verified`, `last_enriched`.

**Event** (line 1344): `name`, `slug`, `promotion` FK, `venue` FK, `date`, `attendance`, `about`, `tv_show` FK, `episode_number`, `season_number`, `event_type` ∈ `tv_episode|ppv|house_show|special|other`; external IDs `tmdb_episode_id`, `cagematch_event_id`; `verified`, `verification_source` (db column `verified_source`), `last_verified`.

**Title / championship** (line 1434): `name`, `slug`, `promotion` FK, `debut_year`, `retirement_year`, `about`, `title_type`, `wikipedia_url`, `last_enriched`, `verified`, `verification_source`, `last_verified`.

**Match** (line 1554): `event` FK, `wrestlers` M2M (plus structured `MatchParticipant` side/role rows), `match_text`, `result`, `winner` FK, `winning_side`, `match_type`, `outcome_type` ∈ `pinfall|submission|dq|count_out|knockout|no_contest|draw|forfeit|other`, `duration_seconds`, `title` FK, `title_changed`, `match_order`, `about`, `cagematch_rating` (0–10), `cagematch_rating_count`, `observer_stars` (0–5); cross-reference IDs `cagematch_match_id`, `profightdb_match_id`; `verified`, `verification_source`, `last_verified`.

## License and attribution

- **LICENSE file is GPL-3.0** (verbatim GNU GPL v3 text, 674 lines; GitHub license detection: `GPL-3.0`).
- **README claims MIT** (badge line 6 and "MIT License — see LICENSE" line 133). **The two conflict; the LICENSE file text (GPL-3.0) is the operative license of the code.** Treat OWDB code as GPL-3.0 until the maintainer resolves the discrepancy.
- Note: the license governs the *software*. The *data* is stated as "Wrestling data sourced from Wikipedia (factual data only)" (README Acknowledgments) — factual data; Wikipedia text content is CC BY-SA. Images are restricted to CC0 / CC BY / CC BY-SA / Public Domain with per-image `image_license` + `image_credit` attribution fields (ImageMixin docstring). **If we reuse images or prose, carry the attribution fields through.** No explicit attribution requirement for factual data is stated in the repo.

## Current data-size limitations

Observed 2026-07-31 on the wrestlingdb.org homepage: **~346 wrestlers, 376 matches, 2,186 events.** The dataset is very small (a `warm_stats_cache` Celery task computes these homepage counts every 5 minutes, so the numbers are live). Coverage is far below what the Kayfabe Connectome needs; treat WrestlingDB as a *supplementary/emerging* source, not a primary one.

## Summary of practical consequences for Kayfabe Connectome

1. There is **no REST API to integrate against today** — signing up and generating an API key at `/account/` yields a key nothing accepts.
2. If/when the API ships, expect (per current dormant config): DRF token auth (`Authorization: Token …`), JSON-only, `PageNumberPagination` `?page=` with page size 100, throttles 100/hr anon and 10,000/hr authenticated — but re-verify everything at that time, since README, settings, and the APIKey model all disagree.
3. The only current programmatic path is scraping the HTML pages (pk/slug routes above) — behind Cloudflare, GPL-3.0 code, Wikipedia-sourced data.

---

## BLOCKED

**Authenticated contract test blocked: `WRESTLINGDB_API_KEY` not present in environment. To unblock: sign up at https://wrestlingdb.org/account/, set `WRESTLINGDB_API_KEY` in `.env`.**

(Note even after unblocking: as of commit `e53596e` there is no endpoint that accepts the key — the authenticated test will only become meaningful once upstream actually mounts API routes.)
