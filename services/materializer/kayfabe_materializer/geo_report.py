"""geo:review — render the resolution review queue as a browsable page.

Reads data/staging/geo-review.json (written by geo:resolve) and writes
data/staging/geo-review.html: every location the resolver could not settle
confidently, ranked by how many cards ride on it, with the candidate places it
weighed and the promotions and dates that give a reviewer the context to
decide. Accepting a row means adding it to config/geo/venue-places.csv or
config/geo/location-overrides.csv and re-running geo:resolve.

The map preview links out rather than embedding a tile service: this page is a
local review artifact and must not fetch anything to be readable.
"""

from __future__ import annotations

import html
import json
import sys

from .geo_source import STAGING

REVIEW_JSON = STAGING / "geo-review.json"
REVIEW_HTML = STAGING / "geo-review.html"

CSS = """
:root { color-scheme: dark; }
body { background:#0a0d14; color:#c8d3e3; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
       margin:0; padding:24px 28px; }
h1 { font-size:18px; margin:0 0 4px; color:#e8eef7; }
p.sub { margin:0 0 20px; color:#7d8ba1; }
table { border-collapse:collapse; width:100%; }
th { text-align:left; font-weight:600; color:#8fa3bf; border-bottom:1px solid #1e2836;
     padding:6px 10px; position:sticky; top:0; background:#0a0d14; }
td { padding:7px 10px; border-bottom:1px solid #141c27; vertical-align:top; }
tr:hover td { background:#0e131c; }
.cards { text-align:right; color:#e8eef7; font-weight:600; white-space:nowrap; }
.raw { color:#e8eef7; }
.dim { color:#6b7a91; }
.cand { color:#9fb3d0; }
.cand b { color:#d8e4f4; font-weight:600; }
a { color:#6ea8ff; text-decoration:none; }
a:hover { text-decoration:underline; }
.pill { display:inline-block; padding:1px 7px; border-radius:9px; font-size:11px;
        border:1px solid currentColor; }
.ambiguous { color:#e0b050; }
.unresolved { color:#e06a5a; }
.rejected { color:#7d8ba1; }
.probable { color:#5aa9e0; }
.coverage { display:flex; gap:28px; margin:0 0 22px; padding:12px 16px;
            background:#0e131c; border:1px solid #1e2836; border-radius:6px; }
.coverage div span { display:block; color:#7d8ba1; font-size:11px; }
.coverage div b { font-size:17px; color:#e8eef7; font-weight:600; }
"""


def render(data: dict) -> str:
    cov = data["coverage"]
    rows = data["queue"]
    out: list[str] = [
        "<!doctype html><meta charset='utf-8'>",
        "<title>Kayfabe GEO — location review queue</title>",
        f"<style>{CSS}</style>",
        "<h1>Location review queue</h1>",
        "<p class='sub'>Every source location the resolver could not settle confidently, "
        "ranked by the number of cards that ride on it. Resolve one by adding a row to "
        "<code>config/geo/venue-places.csv</code> or <code>config/geo/location-overrides.csv</code>, "
        "then re-run <code>pnpm geo:resolve</code>. Coordinates are never invented to close a gap: "
        "an unresolved location stays unresolved, stays counted, and is not plotted.</p>",
        "<div class='coverage'>",
    ]
    for label, key in (
        ("location rows", "row_coverage"),
        ("cards", "card_coverage"),
        ("matches", "match_coverage"),
    ):
        out.append(f"<div><span>{label} resolved</span><b>{cov[key] * 100:.2f}%</b></div>")
    out.append(
        f"<div><span>in this queue</span><b>{len(rows)}</b></div>"
        f"<div><span>cards in this queue</span><b>{sum(r['cards'] for r in rows)}</b></div>"
        "</div>"
    )
    out.append(
        "<table><thead><tr><th>cards</th><th>matches</th><th>source location</th>"
        "<th>state</th><th>promotions</th><th>dates</th><th>chosen / candidates</th>"
        "</tr></thead><tbody>"
    )
    for r in rows:
        e = html.escape
        raw = (
            f"<span class='raw'>{e(r['raw_venue'])}</span><br><span class='dim'>{e(r['raw_city'])}</span>"
            if r["family"] == "csv"
            else f"<span class='raw'>{e(r['raw_name'])}</span>"
        )
        promos = "<br>".join(
            f"{e(p['name'])} <span class='dim'>{p['cards']}</span>" for p in r["promotions"][:4]
        )
        state = f"<span class='pill {r['resolution']}'>{r['resolution']}</span>"
        if r["rung"]:
            state += f"<br><span class='dim'>{e(r['rung'])} · {r['confidence']}</span>"
        if r["chosen"]:
            c = r["chosen"]
            lat, lon = c["latitude"], c["longitude"]
            cell = (
                f"<b>{e(c['displayName'])}</b> "
                f"<a href='https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=11/{lat}/{lon}' "
                f"target='_blank' rel='noopener'>map</a>"
            )
        else:
            cell = "<span class='dim'>not plotted</span>"
        if r["candidates"]:
            alts = "<br>".join(
                f"<span class='dim'>alt</span> {e(c['name'])}, {e(c['admin1'])}, "
                f"{e(c['countryCode'])} <span class='dim'>pop {c['population']:,}</span> "
                f"<a href='https://www.openstreetmap.org/?mlat={c['latitude']}&mlon={c['longitude']}"
                f"#map=11/{c['latitude']}/{c['longitude']}' target='_blank' rel='noopener'>map</a>"
                for c in r["candidates"][:4]
            )
            cell += "<br>" + alts
        if r["notes"]:
            cell += "<br><span class='dim'>" + e("; ".join(r["notes"])) + "</span>"
        out.append(
            f"<tr><td class='cards'>{r['cards']}</td><td class='cards dim'>{r['matches']}</td>"
            f"<td>{raw}</td><td>{state}</td><td class='dim'>{promos}</td>"
            f"<td class='dim'>{e(r['first_date'][:4])}–{e(r['last_date'][:4])}</td>"
            f"<td class='cand'>{cell}</td></tr>"
        )
    out.append("</tbody></table>")
    return "\n".join(out)


def run(argv: list[str] | None = None) -> int:
    if not REVIEW_JSON.exists():
        print(f"no review queue at {REVIEW_JSON} — run: pnpm geo:resolve", file=sys.stderr)
        return 1
    data = json.loads(REVIEW_JSON.read_text(encoding="utf-8"))
    REVIEW_HTML.write_text(render(data), encoding="utf-8")
    print(f"geo:review — {len(data['queue'])} locations -> {REVIEW_HTML}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
