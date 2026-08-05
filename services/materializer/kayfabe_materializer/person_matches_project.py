"""Deterministic per-person match index from the canonical timeline.

Why this exists at all: nothing in the materialized tree could answer "show me
everyone's matches, for one person".  The two things that come close both cost
the client an order of magnitude too much.

  ``timeline/by-year/*.json``   the whole corpus for a year.  Assembling one
                                career out of it means fetching every year they
                                worked: measured at 69 MB for Matt Sydal and 94
                                MB for Samoa Joe.
  ``evidence/pairs/{bb}.json``  keyed by PAIR, so a person's matches are spread
                                across as many buckets as they have opponents —
                                effectively all 256, a 252 MB read.

This projection inverts the timeline by participant instead, into the same
256-bucket layout the people dossiers already use, so one career is exactly one
fetch of roughly 700 KB.

Like ``ratings_project``, its only input is the already-materialized canonical
timeline: it never reads ``data/private`` or the incoming CSV, which makes a
row here a VIEW of the canonical corpus rather than a competing import.  Every
row is one participant's side of one canonical match and carries nothing the
timeline record did not already state.

Absence is preserved as absence.  A missing ``fin`` means the corpus records no
finish, not a finish of "unknown"; a row with no ``t`` was not a title match;
``p`` is present only when the person actually had partners on their side.  The
one derived field is ``r``, and it is derived from ``res`` rather than from side
membership, because a draw is not a loss for the side listed second.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from .normalize import bucket_of

# A canonical `res` that means neither side won. Everything else is read as a
# decision for the winning side, which is the side the timeline lists as `w`.
DRAW_RESULTS = {"draw", "nc", "no contest", "double dq", "double count out"}

RESULT_WIN = 1
RESULT_LOSS = 0
RESULT_DRAW = 2


def out_dir() -> Path:
    root = Path(__file__).resolve().parents[3]
    return root / "data" / "materialized"


def _row(event: dict, side: list[str], other: list[str], person: str, result: int) -> dict:
    row: dict = {
        "m": event["m"],
        "d": event["d"],
        "pr": event["pr"],
        "f": event["form"],
        "r": result,
        "o": other,
    }
    mates = [p for p in side if p != person]
    if mates:
        row["p"] = mates
    if event.get("en"):
        row["en"] = event["en"]
    if event.get("fin"):
        row["fin"] = event["fin"]
    if event.get("stip"):
        row["stip"] = event["stip"]
    if event.get("t"):
        row["t"] = event["t"]
    if event.get("tc"):
        row["tc"] = 1
    return row


def build(root: Path | None = None) -> dict:
    started = time.monotonic()
    root = root or out_dir()
    years_dir = root / "timeline" / "by-year"
    if not years_dir.is_dir():
        raise SystemExit(f"no canonical timeline at {years_dir}")

    buckets: dict[str, dict[str, list[dict]]] = {"%02x" % b: {} for b in range(256)}
    matches = 0
    rows = 0

    for path in sorted(years_dir.glob("*.json")):
        events = json.loads(path.read_text(encoding="utf-8"))
        for event in events:
            winners = event.get("w") or []
            losers = event.get("l") or []
            if not winners and not losers:
                continue
            matches += 1
            drawn = (event.get("res") or "").strip().lower() in DRAW_RESULTS
            for side, other, won in ((winners, losers, True), (losers, winners, False)):
                result = RESULT_DRAW if drawn else (RESULT_WIN if won else RESULT_LOSS)
                for person in side:
                    bucket = buckets[bucket_of(person)]
                    bucket.setdefault(person, []).append(_row(event, side, other, person, result))
                    rows += 1

    # Sorted by (date, match id) so a career reads forwards and the file is
    # byte-identical across runs.
    people = 0
    written = 0
    for name in sorted(buckets):
        block = buckets[name]
        for person in block:
            block[person].sort(key=lambda r: (r["d"], r["m"]))
        people += len(block)
        payload = json.dumps(
            block, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        target = root / "evidence" / "person" / f"{name}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        written += len(payload)

    summary = {
        "projection": "person-matches@1",
        "matches": matches,
        "rows": rows,
        "people": people,
        "bytes": written,
        "seconds": round(time.monotonic() - started, 1),
    }
    return summary


def main(argv: list[str]) -> int:
    summary = build()
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
