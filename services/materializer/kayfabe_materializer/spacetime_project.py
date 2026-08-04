"""spacetime-projection@1 — per-person worldline shards for the Spacetime lens.

Writes data/materialized/spacetime/ and nothing else. Like atlas_project this
is a SEPARATE entry point: the spacetime tree is not in materialize._MANAGED,
so `pnpm data:materialize` neither builds nor deletes it, and this module never
touches graph/, timeline/, entities/, evidence/ or the other projections.

It is built entirely from the ALREADY-MATERIALIZED tree (timeline/by-year,
graph/nodes, graph/promotions, entities/people, evidence/pairs) rather than
from the source corpora — binding every shard to canonical facts and making the
canonical timeline the only thing validation has to agree with.

Identity: spacetime-alias@1. The corpus has one display name per person and no
alias table (LIMITATIONS.md), so Matt Sydal p:116704 and Evan Bourne p:35621
are separate nodes everywhere else in this repository. THIS projection carries
a small curated table (SUBJECTS below) merging documented personas of the same
performer into one canonical worldline, with per-event provenance: every event
record says which persona competed, so the UI can render "competed as Evan
Bourne" without ever inventing a person. The merge is projection-local, exact
ids only, no fuzzy matching, and the validator asserts the merged personas
never co-occur in a match — if they ever did, they would not be the same
person and the build fails rather than shipping the claim.

Relationship classification is NOT re-derived here. The per-match same-side /
opposed / battle-royal call comes from evidence/pairs (encounters@2), so a
worldline convergence carries exactly the classification the rest of the app
shows for that pair. A co-participant with no evidence entry for a given match
(collapsed multi-way loser sides, suppressed pairs) rides as CONTEXT — present,
never classified.

Missing stays missing: ratings are 0 (= absent) unless the source reported
one; csv matches never produce title changes; gaps between documented events
are gaps, and the renderer draws them as dissolution, never as activity.

Wire format — people/{bb}.events.bin, one record per documented match of the
canonical subject, 8 little-endian u32 per record (32 bytes), sorted by
(day, match id as string):

  [0] day            days since 1900-01-01 (D-008 epoch)
  [1] promoIdx       index into dictionaries.json promotions.ids
  [2] flags          bits 0-2  form code (manifest form_bits: singles 0,
                                tag_team 1, multi_way 2, battle_royal 3,
                                team_implied 4, unknown 5)
                     bits 3-4  result: 0 unknown, 1 win, 2 loss, 3 draw
                     bit  5    title match (ts non-empty)
                     bit  6    title change (tc == 1; local_sql only)
                     bit  7    approximate date (apx)
                     bit  8    ppv
                     bits 9-11 persona index into the subject's personas[]
                     bit  12   side contained an unresolved placeholder (unk)
  [3] sameCount | oppCount << 16   (u16 each; classified co-participants)
  [4] ctxCount       co-participants present but unclassified for this match
  [5] partOffset     u32 index into people/{bb}.parts.bin where this event's
                     participants start: sameCount same-side node indexes,
                     then oppCount opposed (battle-royal class included —
                     form bit distinguishes), then ctxCount context
  [6] matchRefIdx    index into this subject's matchRefs[] in people/{bb}.json
  [7] rating100p1    0 = no reported rating; else round(rating*100)+1

people/{bb}.parts.bin is a flat little-endian u32 array of graph node indexes
(graph/nodes.json order). Both binaries are shared per bucket; each subject's
descriptor carries its {offset, count} windows.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

from .normalize import bucket_of, day_to_iso, iso_to_day, pair_key
from . import spacetime_lut

ROOT = Path(__file__).resolve().parents[3]
MAT = ROOT / "data" / "materialized"
OUT = MAT / "spacetime"

SPACETIME_SCHEMA_VERSION = "1.0.0"
SPACETIME_PROJECTION_VERSION = "spacetime-projection@1"

EVENT_STRIDE_U32 = 8
EVENT_STRIDE_BYTES = EVENT_STRIDE_U32 * 4

# Result codes (flags bits 3-4).
RESULT_UNKNOWN, RESULT_WIN, RESULT_LOSS, RESULT_DRAW = 0, 1, 2, 3

# Five-year evidence buckets for relationship echoes: floor(year/5)*5. A bucket
# exists only when it holds documented shared matches — echoes are evidence,
# never invented career phases.
BUCKET_YEARS = 5

# spacetime-alias@1 — the curated identity table. Exact canonical ids only.
# Each entry: canonical persona first; merged personas keep their own node,
# name and evidence identity, and every merged event carries its persona index.
SUBJECTS: list[dict] = [
    {
        "canonical": "p:116704",  # Matt Sydal
        "merged": ["p:35621"],    # competed as Evan Bourne (WWE 2008-2014)
    },
]

REUSES = {
    "person dossier (teams, tops, yearly activity)": "entities/people/{bb}.json",
    "pair evidence detail": "evidence/pairs/{bb}.json",
    "title reign lineage": "entities/championships.json .reigns",
    "node names/positions/indexes": "graph/nodes.json",
    "promotion names": "graph/promotions.json",
}


def dumps(obj) -> str:
    """Deterministic JSON: sorted keys, no spaces, no NaN."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


class Writer:
    def __init__(self, root: Path):
        self.root = root
        self.checksums: dict[str, str] = {}

    def write(self, rel: str, data: str | bytes) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = data.encode("utf-8") if isinstance(data, str) else data
        path.write_bytes(blob)
        self.checksums[rel] = hashlib.sha256(blob).hexdigest()


# --------------------------------------------------------------- pure rules


def result_code(res: str, persona_in_winners: bool) -> int:
    """'def.' names a decided match; 'draw' a draw; 'vs.'/'' record no result."""
    if res == "def.":
        return RESULT_WIN if persona_in_winners else RESULT_LOSS
    if res == "draw":
        return RESULT_DRAW
    return RESULT_UNKNOWN


def pack_flags(form_code: int, result: int, title_match: bool, title_change: bool,
               apx: bool, ppv: bool, persona: int, unk: bool) -> int:
    if not 0 <= persona <= 7:
        raise AssertionError(f"persona index {persona} exceeds 3 bits")
    return (
        (form_code & 0x7)
        | (result & 0x3) << 3
        | int(title_match) << 5
        | int(title_change) << 6
        | int(apx) << 7
        | int(ppv) << 8
        | (persona & 0x7) << 9
        | int(unk) << 12
    )


def rating_encode(mr) -> int:
    """0 is ABSENT, never a zero rating — missing must not read as terrible."""
    if mr is None:
        return 0
    return round(float(mr) * 100) + 1


def bucket_year_of(iso_date: str) -> int:
    return (int(iso_date[:4]) // BUCKET_YEARS) * BUCKET_YEARS


# -------------------------------------------------------------------- build


class _Corpus:
    """Read-only view over the already-materialized tree, cached per bucket."""

    def __init__(self, root: Path):
        self.root = root
        self.manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        if not self.manifest.get("validation", {}).get("passed"):
            raise AssertionError("connectome tree failed its own validation; refusing to project from it")
        nodes = json.loads((root / "graph" / "nodes.json").read_text(encoding="utf-8"))
        self.node_index: dict[str, int] = {nid: i for i, nid in enumerate(nodes["id"])}
        self.node_name: list[str] = nodes["name"]
        # graph/promotions.json keys already carry the "pr:" prefix.
        self.promo_names: dict[str, str] = {
            pid: rec["n"]
            for pid, rec in json.loads(
                (root / "graph" / "promotions.json").read_text(encoding="utf-8")).items()
        }
        self.form_bits: dict[str, int] = self.manifest["form_bits"]
        self._years: dict[int, list] = {}
        self._evidence: dict[str, dict] = {}
        self._people: dict[str, dict] = {}

    def year(self, y: int) -> list:
        if y not in self._years:
            p = self.root / "timeline" / "by-year" / f"{y}.json"
            self._years[y] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
        return self._years[y]

    def evidence_bucket(self, bb: str) -> dict:
        if bb not in self._evidence:
            p = self.root / "evidence" / "pairs" / f"{bb}.json"
            self._evidence[bb] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        return self._evidence[bb]

    def pair_entries(self, a: str, b: str) -> list:
        key = pair_key(a, b)
        return self.evidence_bucket(bucket_of(key)).get(key, [])

    def dossier(self, pid: str) -> dict | None:
        bb = bucket_of(pid)
        if bb not in self._people:
            p = self.root / "entities" / "people" / f"{bb}.json"
            self._people[bb] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        return self._people[bb].get(pid)


def _build_subject(corpus: _Corpus, spec: dict, promo_index: dict[str, int],
                   promo_order: list[str]) -> dict:
    """One canonical subject: merged, classified, sorted event history."""
    personas: list[str] = [spec["canonical"], *spec["merged"]]
    for pid in personas:
        if pid not in corpus.node_index:
            raise AssertionError(f"subject persona {pid} has no graph node")

    persona_meta = []
    y0, y1 = 9999, 0
    for pid in personas:
        d = corpus.dossier(pid)
        if d is None:
            raise AssertionError(f"subject persona {pid} has no dossier")
        persona_meta.append({
            "id": pid,
            "label": corpus.node_name[corpus.node_index[pid]],
            "nodeIdx": corpus.node_index[pid],
            "firstDay": iso_to_day(d["first"]),
            "lastDay": iso_to_day(d["last"]),
            "expected": d["m"],
        })
        y0 = min(y0, int(d["first"][:4]))
        y1 = max(y1, int(d["last"][:4]))

    persona_of = {p["id"]: i for i, p in enumerate(persona_meta)}
    events: list[dict] = []
    seen_matches: dict[str, str] = {}  # m -> persona id, for alias disjointness

    for y in range(y0, y1 + 1):
        for ev in corpus.year(y):
            side_w = ev.get("w") or []
            side_l = ev.get("l") or []
            present = [pid for pid in personas if pid in side_w or pid in side_l]
            if not present:
                continue
            if len(present) > 1:
                raise AssertionError(
                    f"alias personas {present} co-occur in {ev['m']} — not the same person")
            pid = present[0]
            if ev["m"] in seen_matches:
                raise AssertionError(f"match {ev['m']} counted twice for subject")
            seen_matches[ev["m"]] = pid

            # Classify co-participants through the canonical evidence, never a
            # local re-derivation. Placeholders (x:*) carry no identity.
            same: list[int] = []
            opposed: list[int] = []
            context: list[int] = []
            for other in dict.fromkeys([*side_w, *side_l]):
                if other == pid or other.startswith("x:"):
                    continue
                idx = corpus.node_index.get(other)
                if idx is None:
                    continue
                rel = None
                for e in corpus.pair_entries(pid, other):
                    if e["m"] == ev["m"]:
                        rel = e["rel"]
                        break
                if rel == "same":
                    same.append(idx)
                elif rel in ("opposed", "br"):
                    opposed.append(idx)
                else:
                    context.append(idx)

            pr = ev.get("pr") or ""
            if pr and pr not in promo_index:
                promo_index[pr] = len(promo_order)
                promo_order.append(pr)
            form_code = corpus.form_bits.get(ev.get("form") or "unknown", 5)
            titles = ev.get("ts") or []
            events.append({
                "m": ev["m"],
                "d": ev["d"],
                "day": iso_to_day(ev["d"]),
                "en": ev.get("en") or "",
                "promoIdx": promo_index.get(pr, 0) if pr else 0,
                "pr": pr,
                "form": form_code,
                "result": result_code(ev.get("res") or "", pid in side_w),
                "titleMatch": bool(titles),
                "titleChange": ev.get("tc") == 1 and bool(titles),
                "titles": titles,
                "apx": bool(ev.get("apx")),
                "ppv": bool(ev.get("ppv")),
                "unk": bool(ev.get("unk")),
                "persona": persona_of[pid],
                "personaId": pid,
                "rating": rating_encode(ev.get("mr")),
                "same": sorted(same),
                "opposed": sorted(opposed),
                "context": sorted(context),
            })

    # Canonical evidence order: (date, match id AS STRING) — 'm:100' after 'm:36'.
    events.sort(key=lambda e: (e["d"], e["m"]))

    for p in persona_meta:
        got = sum(1 for e in events if e["personaId"] == p["id"])
        if got != p.pop("expected"):
            raise AssertionError(f"{p['id']}: {got} events vs dossier {p['id']}")

    # Relationships: aggregate per co-participant across the merged history.
    # Classification already came from evidence per event, so these totals are
    # the canonical derivation summed — the validator recounts them from
    # evidence/pairs directly.
    node_ids = [""] * len(corpus.node_index)
    for nid, i in corpus.node_index.items():
        node_ids[i] = nid

    def id_of(idx: int) -> str:
        return node_ids[idx]

    rel_totals: dict[str, dict] = {}
    for e in events:
        for idx in e["same"]:
            r = rel_totals.setdefault(id_of(idx), {"same": 0, "opposed": 0, "br": 0,
                                                   "first": e["day"], "last": e["day"],
                                                   "buckets": {}})
            r["same"] += 1
        for idx in e["opposed"]:
            r = rel_totals.setdefault(id_of(idx), {"same": 0, "opposed": 0, "br": 0,
                                                   "first": e["day"], "last": e["day"],
                                                   "buckets": {}})
            if e["form"] == corpus.form_bits.get("battle_royal", 3):
                r["br"] += 1
            else:
                r["opposed"] += 1
        for idx in (*e["same"], *e["opposed"]):
            r = rel_totals[id_of(idx)]
            r["first"] = min(r["first"], e["day"])
            r["last"] = max(r["last"], e["day"])
            by = bucket_year_of(e["d"])
            r["buckets"][by] = r["buckets"].get(by, 0) + 1

    relationships = []
    for rid in sorted(rel_totals):
        r = rel_totals[rid]
        relationships.append({
            "p": rid,
            "n": corpus.node_name[corpus.node_index[rid]],
            "nodeIdx": corpus.node_index[rid],
            "same": r["same"],
            "opposed": r["opposed"],
            "br": r["br"],
            "firstDay": r["first"],
            "lastDay": r["last"],
            "buckets": [[y, r["buckets"][y]] for y in sorted(r["buckets"])],
        })
    # Strongest first, ties by id — the renderer takes a tier-budget prefix and
    # reports the remainder as a number, never silently.
    relationships.sort(key=lambda r: (-(r["same"] + r["opposed"] + r["br"]), r["p"]))

    # Promotions inside this subject's history, strongest first.
    promo_counts: dict[str, dict] = {}
    for e in events:
        if not e["pr"]:
            continue
        c = promo_counts.setdefault(e["pr"], {"count": 0, "first": e["day"], "last": e["day"]})
        c["count"] += 1
        c["first"] = min(c["first"], e["day"])
        c["last"] = max(c["last"], e["day"])
    promos = [
        {"pr": pid, "n": corpus.promo_names.get(pid, pid),
         "count": c["count"], "firstDay": c["first"], "lastDay": c["last"]}
        for pid, c in promo_counts.items()
    ]
    promos.sort(key=lambda p: (-p["count"], p["pr"]))

    # Titles this subject's documented title matches involve.
    title_counts: dict[str, dict] = {}
    for e in events:
        for t in e["titles"]:
            c = title_counts.setdefault(t, {"matches": 0, "changes": 0})
            c["matches"] += 1
            if e["titleChange"]:
                c["changes"] += 1
    titles = [{"t": t, "matches": c["matches"], "changes": c["changes"]}
              for t, c in sorted(title_counts.items())]

    canonical = persona_meta[0]
    return {
        "id": spec["canonical"],
        "label": canonical["label"],
        "nodeIdx": canonical["nodeIdx"],
        "personas": persona_meta,
        "events": events,
        "relationships": relationships,
        "promos": promos,
        "titles": titles,
    }


def build(argv: list[str] | None = None) -> int:
    from .spacetime_validate import run_checks

    argv = argv if argv is not None else sys.argv[1:]
    rebuild_lut = "--lut" in argv
    print(f"spacetime:materialize — {SPACETIME_PROJECTION_VERSION}")

    corpus = _Corpus(MAT)

    promo_order: list[str] = []
    promo_index: dict[str, int] = {}
    subjects = [_build_subject(corpus, spec, promo_index, promo_order)
                for spec in SUBJECTS]

    # ----------------------------------------------------------- lut (slow)
    # The table is pure physics — corpus changes never invalidate it — so an
    # existing pair of files is reused unless --lut forces re-integration.
    lut_f16 = OUT / "lut" / "bridge.f16.bin"
    lut_rgba8 = OUT / "lut" / "bridge-rgba8.bin"
    lut_bytes: dict[str, bytes] = {}
    expected = spacetime_lut.LUT_WIDTH * spacetime_lut.LUT_HEIGHT * 4
    if (not rebuild_lut and lut_f16.exists() and lut_rgba8.exists()
            and lut_f16.stat().st_size == expected * 2
            and lut_rgba8.stat().st_size == expected):
        lut_bytes["lut/bridge.f16.bin"] = lut_f16.read_bytes()
        lut_bytes["lut/bridge-rgba8.bin"] = lut_rgba8.read_bytes()
        print("  lut: reusing existing table (pass --lut to re-integrate)")
    else:
        print(f"  lut: integrating {spacetime_lut.TRACE_V} speed rows x "
              f"{spacetime_lut.TRACE_THETA} rays (minutes, stdlib RK4)")
        rows = spacetime_lut.build_lut(
            progress=lambda i, n, v: print(f"    row {i}/{n} v={v:.3f}c")
            if i % 8 == 0 or i == n else None)
        lut_bytes["lut/bridge.f16.bin"] = spacetime_lut.pack_f16(rows)
        lut_bytes["lut/bridge-rgba8.bin"] = spacetime_lut.pack_rgba8(rows)

    # --------------------------------------------------------------- writing
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    w = Writer(OUT)
    for rel, blob in lut_bytes.items():
        w.write(rel, blob)

    # Group subjects by canonical-id bucket; each bucket shares one events.bin
    # and one parts.bin, descriptors carry their windows.
    by_bucket: dict[str, list[dict]] = {}
    for s in subjects:
        by_bucket.setdefault(bucket_of(s["id"]), []).append(s)

    total_events = total_parts = 0
    for bb in sorted(by_bucket):
        bucket_subjects = sorted(by_bucket[bb], key=lambda s: s["id"])
        ev_words: list[int] = []
        part_words: list[int] = []
        desc: dict[str, dict] = {}
        for s in bucket_subjects:
            ev_offset = len(ev_words) // EVENT_STRIDE_U32
            part_offset = len(part_words)
            match_refs: list[str] = []
            event_names: list[str] = []
            for e in s["events"]:
                same_n, opp_n, ctx_n = len(e["same"]), len(e["opposed"]), len(e["context"])
                if same_n > 0xffff or opp_n > 0xffff:
                    raise AssertionError(f"participant count overflow in {e['m']}")
                ev_words.extend([
                    e["day"],
                    e["promoIdx"],
                    pack_flags(e["form"], e["result"], e["titleMatch"],
                               e["titleChange"], e["apx"], e["ppv"],
                               e["persona"], e["unk"]),
                    same_n | (opp_n << 16),
                    ctx_n,
                    len(part_words),
                    len(match_refs),
                    e["rating"],
                ])
                part_words.extend((*e["same"], *e["opposed"], *e["context"]))
                match_refs.append(e["m"])
                event_names.append(e["en"])
            desc[s["id"]] = {
                "label": s["label"],
                "nodeIdx": s["nodeIdx"],
                "personas": s["personas"],
                "events": {"offset": ev_offset, "count": len(s["events"])},
                "parts": {"offset": part_offset,
                          "count": len(part_words) - part_offset},
                "matchRefs": match_refs,
                "eventNames": event_names,
                "relationships": s["relationships"],
                "promos": s["promos"],
                "titles": s["titles"],
            }
            total_events += len(s["events"])
        total_parts += len(part_words)

        ev_bin = bytearray()
        for word in ev_words:
            ev_bin += word.to_bytes(4, "little")
        pt_bin = bytearray()
        for word in part_words:
            pt_bin += word.to_bytes(4, "little")
        w.write(f"people/{bb}.events.bin", bytes(ev_bin))
        w.write(f"people/{bb}.parts.bin", bytes(pt_bin))
        w.write(f"people/{bb}.json", dumps(desc))

    w.write("dictionaries.json", dumps({
        "promotions": {
            "ids": promo_order,
            "names": [corpus.promo_names.get(p, p)
                      for p in promo_order],
        },
        "subjects": [
            {"canonical": s["id"], "label": s["label"], "bucket": bucket_of(s["id"]),
             "personas": [{"id": p["id"], "label": p["label"]} for p in s["personas"]]}
            for s in subjects
        ],
    }))

    # ------------------------------------------------------------ validation
    counts = {
        "subjects": len(subjects),
        "personas": sum(len(s["personas"]) for s in subjects),
        "events": total_events,
        "titleMatches": sum(1 for s in subjects for e in s["events"] if e["titleMatch"]),
        "titleChanges": sum(1 for s in subjects for e in s["events"] if e["titleChange"]),
        "participantRefs": total_parts,
        "relationships": sum(len(s["relationships"]) for s in subjects),
        "promotions": len(promo_order),
        "buckets": len(by_bucket),
        "lutWidth": spacetime_lut.LUT_WIDTH,
        "lutHeight": spacetime_lut.LUT_HEIGHT,
    }
    passed, checks = run_checks(OUT, counts)

    days = [e["day"] for s in subjects for e in s["events"]]
    manifest = {
        "schema_version": SPACETIME_SCHEMA_VERSION,
        "projection_version": SPACETIME_PROJECTION_VERSION,
        "epoch": "1900-01-01",
        "algorithms": {
            "alias": "spacetime-alias@1 (curated exact-id persona merge, per-event provenance)",
            "classification": "reused evidence/pairs encounters@2 — never re-derived",
            "evidence_buckets": f"floor(year/{BUCKET_YEARS})*{BUCKET_YEARS}, documented matches only",
            "event_order": "(date, match id as string)",
            "bucketing": "fnv1a32-mod-256@1 of the canonical id",
        },
        "event_record": {
            "stride_u32": EVENT_STRIDE_U32,
            "fields": ["day", "promoIdx", "flags", "sameCount|oppCount<<16",
                       "ctxCount", "partOffset", "matchRefIdx", "rating100p1"],
            "flag_bits": {"form": "0-2", "result": "3-4", "titleMatch": "5",
                          "titleChange": "6", "apx": "7", "ppv": "8",
                          "persona": "9-11", "unk": "12"},
        },
        "lut": spacetime_lut.lut_meta(),
        "counts": counts,
        "date_range": [day_to_iso(min(days)), day_to_iso(max(days))] if days else [],
        "day_range": [min(days), max(days)] if days else [],
        "reuses": REUSES,
        "checksums": dict(sorted(w.checksums.items())),
        "validation": {"passed": bool(passed), "checks": checks},
    }
    (OUT / "manifest.json").write_bytes(dumps(manifest).encode("utf-8"))

    for s in subjects:
        aliasN = len(s["personas"]) - 1
        print(f"  {s['label']} ({s['id']}): {len(s['events'])} events"
              f"{f' across {aliasN + 1} personas' if aliasN else ''}, "
              f"{len(s['relationships'])} relationships, {len(s['promos'])} promotions")
    total_bytes = sum((OUT / r).stat().st_size for r in w.checksums)
    print(f"  wrote {len(w.checksums) + 1} files, {total_bytes / 1e6:.1f} MB -> {OUT}")
    for name in sorted(checks):
        c = checks[name]
        print(f"  [{'PASS' if c.get('passed') else 'FAIL'}] {name}")
    print("spacetime:materialize", "OK" if passed else "FAILED VALIDATION")
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(build())
