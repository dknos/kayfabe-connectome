"""Projection B — person encounters (encounters@2).

Derivation rules (docs/CANONICAL-MODEL.md, correctness-critical). A side is a
list of UNITS (each unit a list of member ids). Sources without unit grammar
(the sqlite corpus: '&'-collapsed side rows) contribute exactly one unit per
side, for which @2 reduces to the @1 rules verbatim.

  * battle_royal: brOpposed ('br') winner-side x loser-side only. No partner
    observations, no within-side opposition (quadratic blowup is documented
    as a low-weight class, never a rivalry claim).
  * multi_way: opposed between every pair of DISTINCT units, including units
    on the same listed side (a triple threat's two listed losers opposed each
    other too). Partners within a unit only when the unit is genuine:
      - its side carries >= 2 explicit units (comma grammar proved the
        separation), or
      - it is the whole winner side of a decisive result (@1 rule: the team
        that genuinely won together).
    A single-unit multi-way loser side is a COLLAPSED group: nothing is
    derived within it (neither partner nor opposed pairs).
  * tag_team / team_implied: opposed across sides, partners within each unit.
  * x:unknown members never produce observations; a person listed on both
    sides (source corruption) is dropped from the match and ledgered.
Every observation carries its match id; aggregated pair edges carry the full
supporting evidence list.
"""

from __future__ import annotations

from .normalize import FORM_BITS

REL_SAME = "same"
REL_OPPOSED = "opposed"
REL_BR = "br"

_TEAM_FORMS = ("tag_team", "team_implied")


def _within_pairs(n: int) -> int:
    return n * (n - 1) // 2


def derive_observations(
    form: str,
    kind: str,
    units_w: list[list[str]],
    units_l: list[list[str]],
):
    """Derive pair observations for one canonical match (encounters@2).

    units_w / units_l: per side, lists of units of resolved member ids
    (x:unknown already excluded). Single-unit sides reproduce encounters@1.
    Returns (obs, suppressed):
      obs        : list of (rel, a, b) with a < b lexicographically
      suppressed : dict of suppression counters
    """
    obs: list[tuple[str, str, str]] = []
    sup = {
        "multiway_loser_pairs_suppressed": 0,
        "multiway_draw_pairs_suppressed": 0,
        "battle_royal_partner_pairs_suppressed": 0,
        "dual_side_members_suppressed": 0,
    }

    side_w = [m for u in units_w for m in u]
    side_l = [m for u in units_l for m in u]

    # Source corruption: the same person listed on both sides. Deriving
    # anything for them would assert same-side AND opposed in one match —
    # drop the person from this match entirely instead.
    dual = set(side_w) & set(side_l)
    if dual:
        sup["dual_side_members_suppressed"] = len(dual)
        units_w = [[m for m in u if m not in dual] for u in units_w]
        units_l = [[m for m in u if m not in dual] for u in units_l]
        units_w = [u for u in units_w if u]
        units_l = [u for u in units_l if u]
        side_w = [m for u in units_w for m in u]
        side_l = [m for u in units_l for m in u]

    def emit(rel: str, a: str, b: str) -> None:
        if a != b:
            obs.append((rel, a, b) if a < b else (rel, b, a))

    def partners(unit: list[str]) -> None:
        for i in range(len(unit)):
            for j in range(i + 1, len(unit)):
                emit(REL_SAME, unit[i], unit[j])

    if form == "battle_royal":
        for a in side_w:
            for b in side_l:
                emit(REL_BR, a, b)
        sup["battle_royal_partner_pairs_suppressed"] += _within_pairs(len(side_w))
        sup["battle_royal_partner_pairs_suppressed"] += _within_pairs(len(side_l))
        return obs, sup

    if form == "multi_way":
        # opposed between every pair of distinct units, both across and
        # within listed sides (all units competed against each other)
        units_all = units_w + units_l
        for i in range(len(units_all)):
            for j in range(i + 1, len(units_all)):
                for a in units_all[i]:
                    for b in units_all[j]:
                        emit(REL_OPPOSED, a, b)
        counter = (
            "multiway_loser_pairs_suppressed"
            if kind == "decisive"
            else "multiway_draw_pairs_suppressed"
        )
        for side_units, is_winner in ((units_w, True), (units_l, False)):
            explicit = len(side_units) >= 2
            for u in side_units:
                if explicit or (is_winner and kind == "decisive"):
                    partners(u)
                else:
                    sup[counter] += _within_pairs(len(u))
        return obs, sup

    # singles / tag_team / team_implied / unknown: opposed across sides,
    # partners within each unit of a genuine team form
    for a in side_w:
        for b in side_l:
            emit(REL_OPPOSED, a, b)
    if form in _TEAM_FORMS:
        for u in units_w:
            partners(u)
        for u in units_l:
            partners(u)
    return obs, sup


class PairAggregator:
    """Aggregates observations into pair edges with full evidence lists."""

    __slots__ = ("pairs", "counters", "dual_side_match_ids")

    def __init__(self):
        # pair_key -> mutable record
        self.pairs: dict[str, dict] = {}
        self.counters = {
            "observations_total": 0,
            "partner_obs_by_form": {},
            "opposed_obs_by_form": {},
            "br_obs": 0,
            "multiway_loser_pairs_suppressed": 0,
            "multiway_draw_pairs_suppressed": 0,
            "battle_royal_partner_pairs_suppressed": 0,
            "dual_side_members_suppressed": 0,
        }
        self.dual_side_match_ids: list[int] = []

    def add_match(self, rec: dict) -> None:
        """Derive + fold in all observations for one canonical match record."""
        units_w = rec["sides"][0]["units"]
        units_l = rec["sides"][1]["units"]
        obs, sup = derive_observations(rec["form"], rec["kind"], units_w, units_l)
        for k, v in sup.items():
            self.counters[k] += v
        if sup["dual_side_members_suppressed"]:
            self.dual_side_match_ids.append(str(rec["id"]))
        if not obs:
            return

        form = rec["form"]
        form_bit = 1 << FORM_BITS[form]
        title_first = rec["title_components"][0] if rec["title_components"] else None
        day = rec["day"]
        mid = str(rec["id"])
        mr = rec.get("_mr")
        c = self.counters
        for rel, a, b in obs:
            c["observations_total"] += 1
            if rel == REL_SAME:
                c["partner_obs_by_form"][form] = c["partner_obs_by_form"].get(form, 0) + 1
            elif rel == REL_OPPOSED:
                c["opposed_obs_by_form"][form] = c["opposed_obs_by_form"].get(form, 0) + 1
            else:
                c["br_obs"] += 1

            key = f"{a}|{b}"  # a < b already
            p = self.pairs.get(key)
            if p is None:
                p = {
                    "a": a,
                    "b": b,
                    "same": 0,
                    "opposed": 0,
                    "br": 0,
                    "titleMatches": 0,
                    "_last_title_match": -1,
                    "firstDay": day,
                    "lastDay": day,
                    "promoMask": 0,
                    "formMask": 0,
                    "evidence": [],
                }
                self.pairs[key] = p
            if rel == REL_SAME:
                p["same"] += 1
            elif rel == REL_OPPOSED:
                p["opposed"] += 1
            else:
                p["br"] += 1
            if title_first is not None and p["_last_title_match"] != mid:
                p["titleMatches"] += 1
                p["_last_title_match"] = mid
            if day < p["firstDay"]:
                p["firstDay"] = day
            if day > p["lastDay"]:
                p["lastDay"] = day
            p["formMask"] |= form_bit
            # promoMask bit is resolved by the caller via promo_bit map
            p["promoMask"] |= rec["_promo_bit"]
            p["evidence"].append(
                (
                    rec["date"],
                    mid,
                    str(rec["card_id"]),
                    str(rec["promotion_id"]),
                    rel,
                    form,
                    rec["res"],
                    rec["fin"],
                    title_first,
                    rec["title_change"],
                    mr,
                )
            )

    def sorted_pairs(self) -> list[tuple[str, dict]]:
        """Pairs sorted by canonical pair key; evidence sorted by (date, mid)."""
        items = sorted(self.pairs.items())
        for _, p in items:
            p["evidence"].sort(key=lambda e: (e[0], e[1]))
        return items


def derive_reigns(change_events: list[tuple[str, int, int, list[str]]]) -> list[dict]:
    """reign-derive@1 — intervals between successive title-change events.

    change_events: [(iso_date, card_id, match_id, holders)] for ONE belt.
    Returns reigns sorted by start: [{"holders", "s", "e", "m", "endM"?}].
    The reign started by change i ends at change i+1 (e = its date,
    endM = its match id); the final reign is open (e = None, no endM).
    Vacancies are never invented.
    """
    ev = sorted(change_events, key=lambda t: (t[0], t[1], t[2]))
    reigns: list[dict] = []
    for i, (d, _card, mid, holders) in enumerate(ev):
        r: dict = {"holders": list(holders), "s": d, "e": None, "m": f"m:{mid}"}
        if i + 1 < len(ev):
            nxt = ev[i + 1]
            r["e"] = nxt[0]
            r["endM"] = f"m:{nxt[2]}"
        reigns.append(r)
    return reigns
