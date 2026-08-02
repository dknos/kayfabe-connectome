"""Orchestrator: build every artifact in packages/graph-contract/MATERIALIZED-FORMAT.md.

v2: merges two sources — the sqlite corpus (canonical for the six family
promotions) and the csv corpus (csv-source@1 / crosswalk@1: canonical for
every other promotion, enrichment-only inside family territory).

Deterministic: two runs produce byte-identical trees except manifest.json
"built_at". Output dir: data/materialized/ (override: MATERIALIZED_OUT).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import time
from datetime import datetime, timezone
from pathlib import Path

from . import MATERIALIZATION_SCHEMA_VERSION
from .analytics import degrees, louvain, pair_weight
from .csv_source import csv_source_path
from .extract import extract_all
from .layout import compute_layout
from .merge import merge_csv
from .normalize import FORM_BITS, bucket_of, day_to_iso, iso_to_day
from .project import PairAggregator, derive_reigns
from .ratings_project import build as build_ratings
from .source_db import source_db_path
from .validate import run_checks

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO_ROOT / "data" / "materialized"

# Contract-fixed family promotion bits (manifest.promo_bits). csv promotions
# get bits 6..29 by kept-match count; everything else shares PROMO_OTHER_BIT.
FAMILY_PROMO_BITS = {"1": 0, "692": 1, "2715": 2, "4140": 3, "11561": 4, "11791": 5}
PROMO_NAMED_BITS = 24  # bits 6..29
PROMO_OTHER_BIT = 30

PROMO_NODE_MIN_MATCHES = 100  # csv promotions below this stay filter/record-only
TITLE_NODE_MIN_MATCHES = 10  # csv championships below this stay record-only

_MANAGED = (
    "manifest.json",
    "graph",
    "search",
    "evidence",
    "timeline",
    "entities",
    "reconciliation",
    "quality",
    "ratings",
)


def out_dir() -> Path:
    p = os.environ.get("MATERIALIZED_OUT")
    return Path(p) if p else DEFAULT_OUT


def dumps(obj) -> bytes:
    """Canonical JSON bytes: UTF-8, sorted keys, no NaN, compact."""
    return json.dumps(
        obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


class Writer:
    def __init__(self, root: Path):
        self.root = root
        self.checksums: dict[str, str] = {}

    def write(self, relpath: str, data: bytes) -> None:
        p = self.root / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self.checksums[relpath] = hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build(out: Path | None = None) -> dict:
    t_start = time.monotonic()
    out = out or out_dir()

    # fresh managed tree
    out.mkdir(parents=True, exist_ok=True)
    for name in _MANAGED:
        p = out / name
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()

    src, resolver, belt_map, matches_sql = extract_all()
    if set(int(k) for k in FAMILY_PROMO_BITS) != set(src["promotions"]):
        raise AssertionError("Promotions table does not match contract family promo bits")
    if "Unknown Participants" not in resolver.placeholders:
        raise AssertionError("placeholder detection lost 'Unknown Participants'")

    merged = merge_csv(src, resolver)
    matches_csv = merged["matches_csv"]
    enrichment = merged["enrichment"]
    registry = merged["registry"]

    # promotions: id (str) -> display name; family ints + csv 'c<n>' keys
    promotions: dict[str, str] = {str(i): n for i, n in src["promotions"].items()}
    promotions.update(merged["promos"])
    csv_promo_matches: dict[str, int] = merged["promo_matches"]

    # promo bits: family fixed, then top csv promos by (-matches, name)
    promo_bits = dict(FAMILY_PROMO_BITS)
    ranked = sorted(csv_promo_matches.items(), key=lambda kv: (-kv[1], promotions[kv[0]]))
    for i, (pk, _n) in enumerate(ranked[:PROMO_NAMED_BITS]):
        promo_bits[pk] = 6 + i

    def promo_bit_of(pid: str) -> int:
        return promo_bits.get(pid, PROMO_OTHER_BIT)

    cards = src["cards"]
    belts = src["belts"]

    # title registry: sqlite belts (str ids) + csv titles ('c<n>')
    sql_title_ids = sorted(
        (str(i) for i, e in belt_map.items() if e["kind"] in ("title", "artifact")),
        key=lambda t: int(t),
    )
    csv_titles = merged["titles"]  # 'c<n>' -> {"promo","name"}
    title_names: dict[str, str] = {t: belts[int(t)] for t in sql_title_ids}
    title_names.update({t: v["name"] for t, v in csv_titles.items()})

    all_title_ids = sql_title_ids + sorted(csv_titles, key=lambda t: int(t[1:]))
    title_stats: dict[str, dict] = {
        t: {"m": 0, "firstDay": -1, "lastDay": -1, "promo_counts": {}} for t in all_title_ids
    }
    change_events: dict[str, list] = {t: [] for t in all_title_ids}

    # ------------------------------------------------------------ match pass
    agg = PairAggregator()
    person_stats: dict[str, dict] = {}
    timeline: dict[str, list] = {}
    density: dict[str, list[int]] = {}
    tc_effective = 0
    tc_raw = 0
    forms_count: dict[str, int] = {}

    def pstat(cid: str) -> dict:
        st = person_stats.get(cid)
        if st is None:
            st = {
                "m": 0,
                "firstDay": -1,
                "lastDay": -1,
                "promos": {},
                "years": {},
                "mask": 0,
                "teams": set(),
            }
            person_stats[cid] = st
        return st

    for rec in [*matches_sql, *matches_csv]:
        pid = rec["promotion_id"]
        rec["_promo_bit"] = 1 << promo_bit_of(pid)
        e = enrichment.get(rec["id"]) if isinstance(rec["id"], int) else None
        if e:
            rec["_mr"] = e.get("mr")
            rec["_ppv"] = e.get("ppv", 0)
            rec["_placement"] = e.get("placement")
            if not rec["location"] and e.get("venue"):
                rec["location"] = ", ".join(
                    x for x in (e.get("venue"), e.get("city")) if x
                )
        agg.add_match(rec)
        forms_count[rec["form"]] = forms_count.get(rec["form"], 0) + 1

        year = rec["date"][:4]
        den = density.setdefault(year, [0, 0])
        den[0] += 1
        tc_raw += rec["title_change"]
        comp = rec["title_components"]
        t_first = comp[0] if comp else None
        if rec["title_change"] == 1 and t_first is not None:
            den[1] += 1
            tc_effective += 1

        day = rec["day"]
        seen: set[str] = set()
        for side in rec["sides"]:
            for cid in side["members"]:
                seen.add(cid)
        for cid in seen:
            st = pstat(cid)
            st["m"] += 1
            if st["firstDay"] < 0 or day < st["firstDay"]:
                st["firstDay"] = day
            if day > st["lastDay"]:
                st["lastDay"] = day
            st["promos"][pid] = st["promos"].get(pid, 0) + 1
            st["years"][year] = st["years"].get(year, 0) + 1
            st["mask"] |= rec["_promo_bit"]

        # genuine-team sides -> "teams" listing (mirrors derive_observations)
        form, kind = rec["form"], rec["kind"]
        for si, side in enumerate(rec["sides"]):
            units = side["units"]
            explicit = len(units) >= 2
            for ui, unit in enumerate(units):
                if len(unit) < 2:
                    continue
                genuine = (
                    form in ("tag_team", "team_implied")
                    or (form == "multi_way" and (explicit or (si == 0 and kind == "decisive")))
                )
                if not genuine:
                    continue
                if side["row"] is not None:
                    name = resolver.side_name(side["row"])
                else:
                    name = side["unit_names"][ui]
                for cid in unit:
                    pstat(cid)["teams"].add(name)

        # championships (component-expanded)
        for tid in dict.fromkeys(comp):
            ts = title_stats[tid]
            ts["m"] += 1
            if ts["firstDay"] < 0 or day < ts["firstDay"]:
                ts["firstDay"] = day
            if day > ts["lastDay"]:
                ts["lastDay"] = day
            ts["promo_counts"][pid] = ts["promo_counts"].get(pid, 0) + 1
            if rec["title_change"] == 1:
                change_events[tid].append(
                    (rec["date"], str(rec["card_id"]), str(rec["id"]), list(rec["sides"][0]["members"]))
                )

        ev: dict = {
            "m": f"m:{rec['id']}",
            "c": f"c:{rec['card_id']}",
            "d": rec["date"],
            "pr": f"pr:{pid}",
            "en": rec["event_name"],
            "loc": rec["location"],
            "form": form,
            "stip": rec["stip"],
            "res": rec["res"],
            "fin": rec["fin"],
            "w": list(rec["sides"][0]["members"]),
            "l": list(rec["sides"][1]["members"]),
            "unk": rec["sides"][0]["has_unknown"] or rec["sides"][1]["has_unknown"],
            "t": f"t:{t_first}" if t_first is not None else None,
            # `t` remains the legacy primary title. `ts` is the complete,
            # ordered and de-duplicated canonical title set for multi-belt
            # matches, including [] for a non-title match.
            "ts": [f"t:{tid}" for tid in dict.fromkeys(comp)],
            # tc only meaningful with a real belt — keeps by-year sums equal
            # to density.titleChanges (raw count stays in quality metrics)
            "tc": rec["title_change"] if t_first is not None else 0,
            "dur": rec["dur"],
        }
        # unit grammar (csv multi-ways): lets clients re-derive record-accurate
        # weights with the same encounters@2 rules
        if len(rec["sides"][0]["units"]) > 1:
            ev["wu"] = [list(u) for u in rec["sides"][0]["units"]]
        if len(rec["sides"][1]["units"]) > 1:
            ev["lu"] = [list(u) for u in rec["sides"][1]["units"]]
        if rec.get("_mr") is not None:
            ev["mr"] = rec["_mr"]
        if rec.get("_ppv"):
            ev["ppv"] = 1
        if rec.get("_placement") is not None:
            ev["placement"] = rec["_placement"]
        if rec.get("apx"):
            ev["apx"] = 1
        timeline.setdefault(year, []).append(ev)

    date_min = min(r["date"] for r in [*matches_sql, *matches_csv])
    date_max = max(r["date"] for r in [*matches_sql, *matches_csv])

    # -------------------------------------------------------------- reigns
    championships_reigns: dict[str, list[dict]] = {}
    person_reign_count: dict[str, int] = {}
    person_titles: dict[str, dict[str, list[dict]]] = {}
    total_reigns = 0
    for tid in all_title_ids:
        reigns = derive_reigns(change_events[tid])
        championships_reigns[tid] = reigns
        total_reigns += len(reigns)
        for r in reigns:
            for h in r["holders"]:
                person_reign_count[h] = person_reign_count.get(h, 0) + 1
                person_titles.setdefault(h, {}).setdefault(tid, []).append(
                    {"e": r["e"], "m": r["m"], "s": r["s"]}
                )

    # title promotion assignment: csv titles are fixed to their registry
    # promotion; sqlite titles take the dominant by title-match count
    title_promo: dict[str, str] = {}
    for tid in all_title_ids:
        if tid in csv_titles:
            title_promo[tid] = csv_titles[tid]["promo"]
            continue
        pc = title_stats[tid]["promo_counts"]
        if pc:
            title_promo[tid] = sorted(pc.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        else:
            title_promo[tid] = sorted(FAMILY_PROMO_BITS)[0]

    # ---------------------------------------------------------- node table
    confirmed_ids = sorted(
        i
        for i, n in resolver.rows.items()
        if " & " not in n and n not in resolver.placeholders
    )
    derived = resolver.derived_people()  # [(cid, name, side_rows)] by slug
    csv_people = sorted(registry.csv_people.items())  # [(cid, name)] by id

    node_ids: list[str] = [f"p:{i}" for i in confirmed_ids]
    node_names: list[str] = [resolver.rows[i] for i in confirmed_ids]
    node_res: list[int] = [0] * len(confirmed_ids)
    for cid, name, _rows in derived:
        node_ids.append(cid)
        node_names.append(name)
        node_res.append(1)
    for cid, name in csv_people:
        node_ids.append(cid)
        node_names.append(name)
        node_res.append(2)
    person_count = len(node_ids)

    # promotion nodes: the six family anchors + csv promotions with enough
    # matches to anchor a region; ordered by (-matches, name) so label
    # priority follows corpus weight
    sql_promo_cards: dict[str, list] = {}
    for c in cards.values():
        sql_promo_cards.setdefault(str(c["promotion_id"]), []).append(c)
    promo_node_ids = [str(i) for i in sorted(src["promotions"])]
    promo_node_ids += [
        pk
        for pk, n in sorted(csv_promo_matches.items(), key=lambda kv: (-kv[1], promotions[kv[0]]))
        if n >= PROMO_NODE_MIN_MATCHES
    ]
    for pk in promo_node_ids:
        node_ids.append(f"pr:{pk}")
        node_names.append(promotions[pk])
        node_res.append(0)

    # championship nodes: all sqlite titles + csv titles above the threshold
    title_node_ids = [t for t in all_title_ids if t in set(sql_title_ids)] + [
        t
        for t in all_title_ids
        if t in csv_titles and title_stats[t]["m"] >= TITLE_NODE_MIN_MATCHES
    ]
    for t in title_node_ids:
        node_ids.append(f"t:{t}")
        node_names.append(title_names[t])
        node_res.append(0)
    index = {cid: i for i, cid in enumerate(node_ids)}
    n_nodes = len(node_ids)

    # csv promo activity spans (for promo node first/last days)
    csv_promo_span: dict[str, list[int]] = {}
    for rec in matches_csv:
        span = csv_promo_span.setdefault(rec["promotion_id"], [rec["day"], rec["day"]])
        if rec["day"] < span[0]:
            span[0] = rec["day"]
        if rec["day"] > span[1]:
            span[1] = rec["day"]

    # ------------------------------------------------------------- edges
    pairs = agg.sorted_pairs()
    edge_records: list[tuple[int, ...]] = []
    weight_edges: dict[tuple[int, int], float] = {}
    wdeg: dict[int, float] = {}
    for key, p in pairs:
        ia, ib = index[p["a"]], index[p["b"]]
        a, b = (ia, ib) if ia < ib else (ib, ia)
        w = pair_weight(p["same"], p["opposed"], p["br"])
        weight_edges[(a, b)] = w
        wdeg[a] = wdeg.get(a, 0.0) + w
        wdeg[b] = wdeg.get(b, 0.0) + w
        edge_records.append(
            (
                a,
                b,
                p["same"],
                p["opposed"],
                p["br"],
                p["titleMatches"],
                p["firstDay"],
                p["lastDay"],
                p["promoMask"],
                p["formMask"],
            )
        )
    edge_records.sort(key=lambda r: (r[0], r[1]))

    # ------------------------------------------------- communities + layout
    comm_map = louvain(weight_edges)  # node index -> community id
    deg_map = degrees(weight_edges)
    k_communities = (max(comm_map.values()) + 1) if comm_map else 0

    person_indices = list(range(person_count))
    promo_indices = [index[f"pr:{pk}"] for pk in promo_node_ids]
    title_promo_pairs = []
    for t in title_node_ids:
        pr_idx = index.get(f"pr:{title_promo[t]}")
        if pr_idx is not None:
            title_promo_pairs.append((index[f"t:{t}"], pr_idx))
        else:
            title_promo_pairs.append((index[f"t:{t}"], promo_indices[0]))
    lay = compute_layout(person_indices, comm_map, promo_indices, title_promo_pairs)
    pos = lay["pos"]

    # ------------------------------------------------------------- writing
    w = Writer(out)

    # graph/nodes.json (columnar)
    col_type, col_comm, col_first, col_last = [], [], [], []
    col_matches, col_degree, col_reigns, col_mask = [], [], [], []
    flat_pos: list[float] = []
    for i, cid in enumerate(node_ids):
        if i < person_count:
            st = person_stats.get(cid)
            col_type.append(0)
            col_comm.append(comm_map.get(i, -1))
            col_first.append(st["firstDay"] if st else -1)
            col_last.append(st["lastDay"] if st else -1)
            col_matches.append(st["m"] if st else 0)
            col_degree.append(deg_map.get(i, 0))
            col_reigns.append(person_reign_count.get(cid, 0))
            col_mask.append(st["mask"] if st else 0)
        elif cid.startswith("pr:"):
            pk = cid[3:]
            col_type.append(1)
            col_comm.append(-1)
            if pk in sql_promo_cards:
                pcards = sql_promo_cards[pk]
                col_first.append(min(iso_to_day(c["date"]) for c in pcards))
                col_last.append(max(iso_to_day(c["date"]) for c in pcards))
                col_matches.append(len(pcards))
            else:
                span = csv_promo_span.get(pk)
                col_first.append(span[0] if span else -1)
                col_last.append(span[1] if span else -1)
                col_matches.append(csv_promo_matches.get(pk, 0))
            col_degree.append(0)
            col_reigns.append(0)
            col_mask.append(1 << promo_bit_of(pk))
        else:
            t = cid[2:]
            ts = title_stats[t]
            col_type.append(2)
            col_comm.append(-1)
            col_first.append(ts["firstDay"])
            col_last.append(ts["lastDay"])
            col_matches.append(ts["m"])
            col_degree.append(0)
            col_reigns.append(len(championships_reigns[t]))
            col_mask.append(1 << promo_bit_of(title_promo[t]))
        x, y, z = pos[i]
        flat_pos.extend((x, y, z))

    w.write(
        "graph/nodes.json",
        dumps(
            {
                "count": n_nodes,
                "id": node_ids,
                "type": col_type,
                "name": node_names,
                "community": col_comm,
                "pos": flat_pos,
                "firstDay": col_first,
                "lastDay": col_last,
                "matches": col_matches,
                "degree": col_degree,
                "reigns": col_reigns,
                "promoMask": col_mask,
                "resolution": node_res,
            }
        ),
    )

    # graph/edges.bin
    buf = bytearray()
    for r in edge_records:
        buf += struct.pack("<10I", *r)
    w.write("graph/edges.bin", bytes(buf))

    # graph/promotions.json — every promotion (node or not) for name/bit lookup
    promos_out: dict[str, dict] = {}
    for pk, name in promotions.items():
        entry: dict = {"n": name}
        if pk in sql_promo_cards:
            entry["m"] = len(sql_promo_cards[pk])
            entry["src"] = "local_sql"
        else:
            entry["m"] = csv_promo_matches.get(pk, 0)
            entry["src"] = "csv_initial_matches"
        b = promo_bits.get(pk)
        if b is not None:
            entry["bit"] = b
        promos_out[f"pr:{pk}"] = entry
    w.write("graph/promotions.json", dumps(promos_out))

    # graph/communities.json
    comm_members: dict[int, list[int]] = {}
    for idx, c in comm_map.items():
        comm_members.setdefault(c, []).append(idx)
    labels, sizes, centers, top_members = [], [], [], []
    for c in range(k_communities):
        members = sorted(comm_members.get(c, []))
        sizes.append(len(members))
        promo_counts: dict[str, int] = {}
        decade_counts: dict[int, int] = {}
        cx = cy = cz = 0.0
        for m in members:
            x, y, z = pos[m]
            cx += x
            cy += y
            cz += z
            st = person_stats.get(node_ids[m])
            if st:
                for p, n in st["promos"].items():
                    promo_counts[p] = promo_counts.get(p, 0) + n
                for yr, n in st["years"].items():
                    d = int(yr) // 10 * 10
                    decade_counts[d] = decade_counts.get(d, 0) + n
        n = max(1, len(members))
        centers.extend((round(cx / n, 4), round(cy / n, 4), round(cz / n, 4)))
        dom_promo = (
            sorted(promo_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            if promo_counts
            else promo_node_ids[0]
        )
        dom_decade = (
            sorted(decade_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            if decade_counts
            else 0
        )
        labels.append(f"{promotions[dom_promo]} · {dom_decade}s")
        ranked_m = sorted(members, key=lambda m: (-wdeg.get(m, 0.0), m))[:10]
        top_members.append([node_ids[m] for m in ranked_m])
    w.write(
        "graph/communities.json",
        dumps(
            {
                "count": k_communities,
                "label": labels,
                "size": sizes,
                "center": centers,
                "topMembers": top_members,
            }
        ),
    )

    # search/entities.json — people, node promotions, node titles, events
    event_cards: dict[int, list[str]] = {}
    for c in cards.values():
        event_cards.setdefault(c["event_id"], []).append(c["date"])
    entities: list[dict] = []
    for i in range(person_count):
        cid = node_ids[i]
        st = person_stats.get(cid)
        e: dict = {"id": cid, "t": "person", "n": node_names[i], "m": st["m"] if st else 0}
        if st and st["m"] > 0:
            e["first"] = _day_iso(st["firstDay"])
            e["last"] = _day_iso(st["lastDay"])
            pm = sorted(
                st["promos"].items(), key=lambda kv: (-kv[1], promotions[kv[0]])
            )[:6]
            e["pm"] = [promotions[p] for p, _n in pm]
        entities.append(e)
    for pk in promo_node_ids:
        i = index[f"pr:{pk}"]
        e = {"id": f"pr:{pk}", "t": "promotion", "n": promotions[pk], "m": col_matches[i]}
        if col_first[i] >= 0:
            e["first"] = _day_iso(col_first[i])
            e["last"] = _day_iso(col_last[i])
        entities.append(e)
    for t in title_node_ids:
        i = index[f"t:{t}"]
        e = {"id": f"t:{t}", "t": "title", "n": title_names[t], "m": col_matches[i]}
        if col_first[i] >= 0:
            e["first"] = _day_iso(col_first[i])
            e["last"] = _day_iso(col_last[i])
        entities.append(e)
    for evid in sorted(src["events"]):
        dates = sorted(event_cards.get(evid, []))
        e = {"id": f"en:{evid}", "t": "event", "n": src["events"][evid], "m": len(dates)}
        if len(dates) > 1:
            e["first"] = dates[0]
            e["last"] = dates[-1]
        entities.append(e)
    csv_event_dates: dict[str, list[str]] = {}
    csv_event_matches: dict[str, int] = {}
    for rec in matches_csv:
        ek = rec["event_id"]
        if ek is None:
            continue
        csv_event_matches[ek] = csv_event_matches.get(ek, 0) + 1
        csv_event_dates.setdefault(ek, []).append(rec["date"])
    for ek in sorted(csv_event_dates, key=lambda k: int(k[1:])):
        dates = sorted(set(csv_event_dates[ek]))
        e = {
            "id": f"en:{ek}",
            "t": "event",
            "n": merged["events"][ek],
            "m": csv_event_matches[ek],
        }
        if len(dates) > 1:
            e["first"] = dates[0]
            e["last"] = dates[-1]
        entities.append(e)
    w.write("search/entities.json", dumps(entities))

    # evidence/pairs/{bb}.json
    buckets: dict[str, dict[str, list]] = {"%02x" % b: {} for b in range(256)}
    partner_counts: dict[str, dict[str, int]] = {}
    opponent_counts: dict[str, dict[str, int]] = {}
    for key, p in pairs:
        entries = []
        for d, mid, card_id, promo, rel, form, res, fin, t_first, tc, mr in p["evidence"]:
            entry = {
                "m": f"m:{mid}",
                "c": f"c:{card_id}",
                "d": d,
                "pr": f"pr:{promo}",
                "rel": rel,
                "form": form,
                "res": res,
                "fin": fin,
                "t": f"t:{t_first}" if t_first is not None else None,
                "tc": tc,
            }
            if mr is not None:
                entry["mr"] = mr
            entries.append(entry)
        buckets[bucket_of(key)][key] = entries
        if p["same"]:
            partner_counts.setdefault(p["a"], {})[p["b"]] = p["same"]
            partner_counts.setdefault(p["b"], {})[p["a"]] = p["same"]
        if p["opposed"]:
            opponent_counts.setdefault(p["a"], {})[p["b"]] = p["opposed"]
            opponent_counts.setdefault(p["b"], {})[p["a"]] = p["opposed"]
    for bb in sorted(buckets):
        w.write(f"evidence/pairs/{bb}.json", dumps(buckets[bb]))

    # timeline
    w.write(
        "timeline/density.json",
        dumps({"years": {y: {"matches": v[0], "titleChanges": v[1]} for y, v in density.items()}}),
    )
    for year in sorted(timeline):
        recs = sorted(timeline[year], key=lambda r: (r["d"], r["c"], r["m"]))
        w.write(f"timeline/by-year/{year}.json", dumps(recs))

    # entities/people/{bb}.json
    people_buckets: dict[str, dict[str, dict]] = {"%02x" % b: {} for b in range(256)}
    derived_src = {cid: rows for cid, _n, rows in derived}
    csv_people_set = set(registry.csv_people)
    for i in range(person_count):
        cid = node_ids[i]
        st = person_stats.get(cid)
        top_partners = sorted(
            partner_counts.get(cid, {}).items(), key=lambda kv: (-kv[1], kv[0])
        )[:20]
        top_opponents = sorted(
            opponent_counts.get(cid, {}).items(), key=lambda kv: (-kv[1], kv[0])
        )[:20]
        titles_list = []
        for tid in sorted(person_titles.get(cid, {})):
            reigns = sorted(
                person_titles[cid][tid], key=lambda r: (r["s"], r["m"])
            )
            titles_list.append(
                {"t": f"t:{tid}", "reigns": [{"e": r["e"], "m": r["m"], "s": r["s"]} for r in reigns]}
            )
        if cid in csv_people_set:
            src_field: dict = {"csv_initial_name": registry.csv_people[cid]}
        elif cid.startswith("p:d"):
            src_field = {"local_sql_side_rows": derived_src[cid]}
        else:
            src_field = {"local_sql": int(cid[2:])}
        dossier = {
            "n": node_names[i],
            "first": _day_iso(st["firstDay"]) if st and st["m"] else "",
            "last": _day_iso(st["lastDay"]) if st and st["m"] else "",
            "m": st["m"] if st else 0,
            "promos": {f"pr:{p}": n for p, n in st["promos"].items()} if st else {},
            "years": dict(sorted(st["years"].items())) if st else {},
            "top": {
                "partners": [[k, v] for k, v in top_partners],
                "opponents": [[k, v] for k, v in top_opponents],
            },
            "teams": sorted(st["teams"]) if st else [],
            "titles": titles_list,
            "src": src_field,
        }
        people_buckets[bucket_of(cid)][cid] = dossier
    for bb in sorted(people_buckets):
        w.write(f"entities/people/{bb}.json", dumps(people_buckets[bb]))

    # entities/championships.json — every title with any activity
    champs: dict[str, dict] = {}
    for t in all_title_ids:
        if title_stats[t]["m"] == 0 and t in csv_titles:
            continue
        champs[f"t:{t}"] = {
            "n": title_names[t],
            "pr": f"pr:{title_promo[t]}",
            "artifact": t not in csv_titles and belt_map[int(t)]["kind"] == "artifact",
            "reigns": championships_reigns[t],
            "titleMatches": title_stats[t]["m"],
            "changes": len(change_events[t]),
            "src": "csv_initial_matches" if t in csv_titles else "local_sql",
        }
    w.write("entities/championships.json", dumps(champs))

    # reconciliation/decisions.json
    confirmed_parts = set()
    for i, n in resolver.rows.items():
        if " & " in n:
            for part in n.split(" & "):
                if part in resolver.name_to_pid:
                    confirmed_parts.add(part)
    split_ids = sorted(i for i, e in belt_map.items() if e["kind"] == "split")
    artifact_ids = sorted(i for i, e in belt_map.items() if e["kind"] == "artifact")
    cross_source_people = sum(
        1
        for name, cid in registry.name_to_cid.items()
        if not cid.startswith("p:c")
    )
    recon = {
        "summary": {
            "exact_name_split": {
                "confirmed": len(confirmed_parts),
                "derived": len(derived),
                "unresolved_part_occurrences": resolver.unresolved_part_occurrences,
            },
            "placeholders_detected": sorted(resolver.placeholders),
            "csv_identity": {
                "csv_only_people": len(registry.csv_people),
                "cross_source_confirmed_names": cross_source_people,
                "csv_placeholders": sorted(registry.placeholders)[:40],
            },
            "crosswalk": merged["quality"]["crosswalk"],
            "csv_staging": merged["quality"]["staging"],
            "belt_splits": {"split": len(split_ids), "artifacts_kept": len(artifact_ids)},
        },
        "samples": {
            "derived_people": [
                {"id": cid, "name": name, "side_rows": rows[:8]}
                for cid, name, rows in derived[:50]
            ],
            "belt_artifacts": [{"id": f"t:{i}", "name": belts[i]} for i in artifact_ids],
            "belt_split_decisions": [
                {
                    "id": i,
                    "name": belts[i],
                    "components": [f"t:{c}" for c in belt_map[i]["components"]],
                    "parts": belt_map[i]["parts"],
                }
                for i in split_ids
            ],
        },
    }
    w.write("reconciliation/decisions.json", dumps(recon))

    # ---------------------------------------------------------- validation
    passed, checks = run_checks(out, promo_bits, PROMO_OTHER_BIT)

    counters = dict(agg.counters)
    counters["partner_obs_by_form"] = dict(sorted(counters["partner_obs_by_form"].items()))
    counters["opposed_obs_by_form"] = dict(sorted(counters["opposed_obs_by_form"].items()))
    counters["dual_side_match_ids"] = sorted(agg.dual_side_match_ids)
    metrics = {
        "passed": passed,
        "checks": checks,
        "counters": {
            **counters,
            "battle_royal_edges": sum(1 for r in edge_records if r[4] > 0),
            "battle_royal_partner_obs": counters["partner_obs_by_form"].get("battle_royal", 0),
            "singles_partner_obs": counters["partner_obs_by_form"].get("singles", 0),
            "forms": dict(sorted(forms_count.items())),
            "title_changes_raw": tc_raw,
            "title_changes_effective": tc_effective,
            "reigns_total": total_reigns,
            "unresolved_side_part_occurrences": resolver.unresolved_part_occurrences,
            "placeholder_rows": resolver.placeholder_row_ids,
            "persons_with_zero_matches": sum(
                1 for i in range(person_count) if node_ids[i] not in person_stats
            ),
        },
        "csv": merged["quality"],
    }
    w.write("quality/metrics.json", dumps(metrics))

    manifest = {
        "schema_version": MATERIALIZATION_SCHEMA_VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "source_fingerprint": _sha256_file(source_db_path()),
        "sources": {
            "local_sql": _sha256_file(source_db_path()),
            "csv_initial_matches": _sha256_file(csv_source_path()),
        },
        "epoch": "1900-01-01",
        "layout_version": "global-layout@3",
        "projection_version": "encounters@2",
        "algorithms": {
            "communities": "louvain-seeded@1",
            "resolution": "exact-name-split@1",
            "csv_resolution": "csv-name-registry@1",
            "crosswalk": "crosswalk@1",
            "form_classify": "form-classify@2",
            "belt_split": "belt-split@1",
            "reign_derive": "reign-derive@1",
        },
        "counts": {
            "people": len(confirmed_ids),
            "derived_people": len(derived),
            "csv_people": len(csv_people),
            "promotions": len(promotions),
            "promotion_nodes": len(promo_node_ids),
            "titles": len(all_title_ids),
            "title_nodes": len(title_node_ids),
            "cards": len(cards),
            "matches": len(matches_sql) + len(matches_csv),
            "matches_local_sql": len(matches_sql),
            "matches_csv": len(matches_csv),
            "matches_csv_enriching": merged["quality"]["crosswalk"]["family_enriched"],
            "matches_csv_excluded": merged["quality"]["crosswalk"]["family_unmatched_excluded"],
            "edges": len(edge_records),
            "communities": k_communities,
            "title_changes": tc_effective,
            "unresolved_side_parts": resolver.unresolved_part_occurrences,
        },
        "date_range": [date_min, date_max],
        "edges_bin": {
            "count": len(edge_records),
            "stride_u32": 10,
            "fields": [
                "a",
                "b",
                "sameSide",
                "opposed",
                "brOpposed",
                "titleMatches",
                "firstDay",
                "lastDay",
                "promoMask",
                "formMask",
            ],
        },
        "promo_bits": promo_bits,
        "promo_other_bit": PROMO_OTHER_BIT,
        "form_bits": dict(FORM_BITS),
        "checksums": dict(sorted(w.checksums.items())),
        "validation": {
            "passed": passed,
            "checks": {k: bool(v.get("passed", True)) for k, v in checks.items()},
        },
    }
    (out / "manifest.json").write_bytes(dumps(manifest))

    # Ratings is a managed projection of the canonical timeline. Its builder
    # re-validates the emitted bytes and raises on any failure, so a normal
    # full materialization cannot publish a stale or corrupt ratings tree.
    ratings_summary = build_ratings(out, out / "ratings")

    wall = time.monotonic() - t_start
    return {
        "out": str(out),
        "wall_s": round(wall, 1),
        "passed": passed,
        "counts": manifest["counts"],
        "reigns_total": total_reigns,
        # Primary-manifest files plus the separately checksummed ratings tree.
        "files": len(w.checksums) + 1 + ratings_summary["files"],
        "ratings": ratings_summary,
    }


def _day_iso(day: int) -> str:
    return day_to_iso(day)


def main() -> None:
    summary = build()
    c = summary["counts"]
    print(
        "materialize OK" if summary["passed"] else "materialize FAILED VALIDATION",
        f"— out={summary['out']}",
        f"files={summary['files']}",
        f"wall={summary['wall_s']}s",
    )
    print(
        f"people={c['people']}+{c['derived_people']}d+{c['csv_people']}c",
        f"promos={c['promotions']} ({c['promotion_nodes']} nodes)",
        f"titles={c['titles']} ({c['title_nodes']} nodes)",
        f"matches={c['matches']} (sql={c['matches_local_sql']} csv={c['matches_csv']})",
        f"edges={c['edges']} communities={c['communities']}",
        f"tc={c['title_changes']} reigns={summary['reigns_total']}",
    )
    if not summary["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
