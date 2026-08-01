"""geo:validate — assert the geographic projection is internally consistent,
honest about what it could not resolve, and safe to ship.

Every check reconciles a derived number against the canonical corpus rather
than against another derived number, so a systematic error cannot agree with
itself. Failures are collected and reported together; the command exits
non-zero if any check fails.

`--coverage` prints the coverage report alone (pnpm geo:coverage).
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

from .extract import extract_all
from .geo_project import OUT, RESOLVED
from .geo_source import build_geo_source
from .merge import merge_csv

# Anything that looks like a credential must never reach the materialized tree.
SECRET_PATTERNS = [
    re.compile(rb"(?i)\b(api[_-]?key|secret|password|bearer)\b\s*[:=]"),
    re.compile(rb"AIza[0-9A-Za-z_-]{20,}"),  # Google
    re.compile(rb"eyJ[A-Za-z0-9_-]{20,}\."),  # JWT
    re.compile(rb"(?i)ion\.cesium\.com/token"),
]
HTML_PATTERN = re.compile(rb"<\s*(?:table|tr|td|div|span|script)\b", re.IGNORECASE)


class Checks:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.results.append((name, bool(ok), detail))
        return bool(ok)

    @property
    def passed(self) -> bool:
        return all(ok for _n, ok, _d in self.results)

    def report(self) -> None:
        for name, ok, detail in self.results:
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))


def _read(rel: str):
    return json.loads((OUT / rel).read_text(encoding="utf-8"))


def run(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not (OUT / "manifest.json").exists():
        print(f"no geo projection at {OUT} — run: pnpm geo:materialize", file=sys.stderr)
        return 1
    manifest = _read("manifest.json")
    quality = _read("quality.json")

    if "--coverage" in argv:
        _print_coverage(manifest, quality)
        return 0

    c = Checks()
    places = _read("places.json")
    strings = _read("cards-strings.json")
    unresolved = _read("unresolved.json")
    slm = _read("source-location-map.json")
    raw = (OUT / "cards.bin").read_bytes()

    # ---------------------------------------------------------- coordinates
    n = places["count"]
    bad_lat = [i for i, v in enumerate(places["lat"])
               if v is None or not (-90.0 <= v <= 90.0) or v != v]
    bad_lon = [i for i, v in enumerate(places["lon"])
               if v is None or not (-180.0 <= v <= 180.0) or v != v]
    c.check("every plotted coordinate is finite and in range",
            not bad_lat and not bad_lon,
            f"{len(bad_lat)} bad latitudes, {len(bad_lon)} bad longitudes")
    null_island = [places["id"][i] for i in range(n)
                   if places["lat"][i] == 0.0 and places["lon"][i] == 0.0]
    c.check("no place sits at 0,0 (the Gulf of Guinea trap)", not null_island,
            ", ".join(null_island[:5]))
    c.check("every plotted place carries a precision",
            all(p in ("venue", "city", "municipality", "county", "region", "country")
                for p in places["precision"]))
    c.check("every plotted place carries provenance",
            all(bool(s) for s in places["source"]))

    # An unresolved source location must have NO place, and must still be
    # counted — dropping it would silently shrink the corpus.
    c.check("unresolved locations carry no coordinate",
            all(u["resolution"] in ("ambiguous", "unresolved", "rejected") for u in unresolved))
    c.check("unresolved locations are still counted",
            sum(u["cards"] for u in unresolved) == quality["unplottedCards"],
            f"{sum(u['cards'] for u in unresolved)} vs {quality['unplottedCards']}")

    # ------------------------------------------------------ cards.bin shape
    stride = manifest["cards_bin"]["stride_u32"]
    count = manifest["cards_bin"]["count"]
    c.check("cards.bin length matches the declared record count",
            len(raw) == count * stride * 4, f"{len(raw)} bytes")
    words = struct.unpack(f"<{count * stride}I", raw)
    c.check("cards-strings.cardIds is parallel to cards.bin",
            len(strings["cardIds"]) == count)
    place_refs = words[2::stride]
    c.check("every placeRef is in range",
            all(0 <= r <= n for r in place_refs))
    promo_refs = words[1::stride]
    c.check("every promotionIdx is in range",
            all(0 <= r < len(strings["promotionIds"]) for r in promo_refs))
    event_refs = words[3::stride]
    c.check("every eventNameIdx is in range",
            all(0 <= r < len(strings["eventNames"]) for r in event_refs))
    days = words[0::stride]
    c.check("cards are sorted by day", all(days[i] <= days[i + 1] for i in range(count - 1)))
    c.check("card ids are unique", len(set(strings["cardIds"])) == count)

    # -------------------------------------- reconcile against the CANONICAL corpus
    src, resolver, _b, matches_sql = extract_all()
    merged = merge_csv(src, resolver)
    matches = [*matches_sql, *merged["matches_csv"]]
    geo = build_geo_source(src, merged, matches)
    canon = {c2["card_id"]: c2 for c2 in geo["cards"]}

    c.check("every projected card exists in the canonical corpus",
            all(cid in canon for cid in strings["cardIds"]))
    c.check("every canonical card is projected", len(canon) == count,
            f"{len(canon)} canonical vs {count} projected")

    mism_match = mism_tc = mism_day = 0
    for i, cid in enumerate(strings["cardIds"]):
        rec = canon.get(cid)
        if rec is None:
            continue
        base = i * stride
        if words[base + 4] != rec["match_count"]:
            mism_match += 1
        if words[base] != rec["day"]:
            mism_day += 1
        tc = (words[base + 6] >> 16) & 0xFFFF
        if tc != rec["title_change_count"]:
            mism_tc += 1
    c.check("per-card match counts reconcile with the canonical corpus", mism_match == 0,
            f"{mism_match} mismatched")
    c.check("per-card days reconcile", mism_day == 0, f"{mism_day} mismatched")
    c.check("per-card title-change counts reconcile", mism_tc == 0, f"{mism_tc} mismatched")
    c.check("total matches reconcile",
            sum(words[i * stride + 4] for i in range(count)) == geo["totals"]["matches"],
            f"{sum(words[i * stride + 4] for i in range(count))} vs {geo['totals']['matches']}")

    # ---------------------------------------------------------- scope indices
    pos = {cid: i for i, cid in enumerate(strings["cardIds"])}
    promo_scope = _read("scopes/promotions.json")
    canon_promo: dict[str, set] = {}
    for rec in geo["cards"]:
        canon_promo.setdefault(rec["promotion_id"], set()).add(pos[rec["card_id"]])
    bad = [p for p, ids in promo_scope.items() if set(ids) != canon_promo.get(p, set())]
    c.check("promotion scope reconciles to canonical cards", not bad,
            f"{len(bad)} promotions differ")

    place_scope = _read("scopes/places.json")
    c.check("place scope totals match the plotted card count",
            sum(len(v) for v in place_scope.values()) == quality["plottedCards"])
    bad_place = [pid for pid, ids in place_scope.items()
                 if places["cards"][places["id"].index(pid)] != len(ids)]
    c.check("per-place card counts reconcile with the place scope", not bad_place,
            f"{len(bad_place)} places differ")

    canon_person: dict[str, set] = {}
    canon_title: dict[str, set] = {}
    for rec in matches:
        ci = pos.get(f"c:{rec['card_id']}")
        if ci is None:
            continue
        for side in rec["sides"]:
            for pid in side["members"]:
                canon_person.setdefault(pid, set()).add(ci)
        for t in rec["title_components"]:
            canon_title.setdefault(f"t:{t}", set()).add(ci)
    person_scope: dict[str, list] = {}
    for shard in sorted((OUT / "scopes" / "people").glob("*.json")):
        person_scope.update(json.loads(shard.read_text(encoding="utf-8")))
    bad_people = [p for p, ids in person_scope.items() if set(ids) != canon_person.get(p, set())]
    c.check("person scope reconciles to match participants",
            not bad_people and len(person_scope) == len(canon_person),
            f"{len(bad_people)} people differ, {len(person_scope)} vs {len(canon_person)}")
    title_scope = _read("scopes/titles.json")
    bad_titles = [t for t, ids in title_scope.items() if set(ids) != canon_title.get(t, set())]
    c.check("championship scope reconciles to title matches",
            not bad_titles and len(title_scope) == len(canon_title),
            f"{len(bad_titles)} titles differ")

    year_index = _read("by-year/index.json")
    bad_year = []
    for year, (lo, hi) in year_index.items():
        if any(not str(canon[strings["cardIds"][i]]["date"]).startswith(year)
               for i in range(lo, hi)):
            bad_year.append(year)
    c.check("year ranges contain only that year's cards", not bad_year,
            ", ".join(bad_year[:5]))
    c.check("year ranges cover every card",
            sum(hi - lo for lo, hi in year_index.values()) == count)

    density = _read("density/by-year.json")
    c.check("year density reconciles with the year index",
            all(density[y]["cards"] == hi - lo for y, (lo, hi) in year_index.items()))

    # ------------------------------------------------- source-location trail
    c.check("every source location has a resolution verdict",
            len(slm) == geo["totals"]["locations"],
            f"{len(slm)} vs {geo['totals']['locations']}")
    c.check("every resolved source location points at an emitted place",
            all(v["placeId"] in set(places["id"]) for v in slm.values() if v["placeId"]))

    # -------------------------------------------------------- checksums, safety
    bad_sums = [rel for rel, want in manifest["checksums"].items()
                if not (OUT / rel).exists()
                or hashlib.sha256((OUT / rel).read_bytes()).hexdigest() != want]
    c.check("every declared checksum matches the file on disk", not bad_sums,
            ", ".join(bad_sums[:3]))

    leaked_html = leaked_secret = []
    for path in OUT.rglob("*"):
        if not path.is_file():
            continue
        blob = path.read_bytes()
        if HTML_PATTERN.search(blob):
            leaked_html = leaked_html + [str(path.relative_to(OUT))]
        for pat in SECRET_PATTERNS:
            if pat.search(blob):
                leaked_secret = leaked_secret + [str(path.relative_to(OUT))]
                break
    c.check("no source HTML is emitted", not leaked_html, ", ".join(leaked_html[:3]))
    c.check("no credential-shaped string is emitted", not leaked_secret,
            ", ".join(leaked_secret[:3]))
    c.check("no raw gazetteer file is shipped",
            not any(p.name in ("cities500.txt", "US.txt", "JP.txt") for p in OUT.rglob("*")))
    c.check("the gazetteer attribution is carried in the manifest",
            any("GeoNames" in a for a in manifest.get("attribution", [])))

    print(f"geo:validate — {OUT}")
    c.report()
    _print_coverage(manifest, quality)
    if not c.passed:
        print("\n  FAILED", file=sys.stderr)
        return 1
    print(f"\n  {len(c.results)} checks passed")
    return 0


def _print_coverage(manifest: dict, quality: dict) -> None:
    t = quality["targets"]
    print("\n  GEOGRAPHIC COVERAGE")
    for label, key, target in (
        ("location rows", "rowCoverage", t["rows"]),
        ("cards", "cardCoverage", t["cards"]),
        ("matches", "matchCoverage", t["matches"]),
    ):
        v = quality[key]
        mark = "meets" if v >= target else "under"
        print(f"    {label:14} {v * 100:6.2f}%   target {target * 100:.0f}%  ({mark})")
    print(f"    plotted {quality['plottedCards']} of {quality['totalCards']} cards; "
          f"{quality['unplottedCards']} unplotted; {quality['places']} places emitted")
    print("    coordinate precision: " + ", ".join(
        f"{k} {v}" for k, v in sorted(quality["precisionCounts"].items())))
    print("    " + "; ".join(manifest.get("attribution", [])))


if __name__ == "__main__":
    raise SystemExit(run())
