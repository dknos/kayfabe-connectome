"""Projection B — person encounters (encounters@1).

Derivation rules (docs/CANONICAL-MODEL.md, correctness-critical):
  * Opposed: winner-side members x loser-side members — always derived,
    EXCEPT battle_royal which yields brOpposed ('br') instead.
  * Same-side (partner): within a side ONLY when the side is a genuine team:
      - tag_team / team_implied: both sides;
      - multi_way: ONLY the winner side, and only when the result is decisive
        (a real team that won together). NEVER within the collapsed loser
        group — neither partner nor opposed pairs are derived there.
      - battle_royal: no partner observations at all.
  * x:unknown members never produce observations (they are absent from the
    resolved member lists; has_unknown flags the side).
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


def derive_observations(form: str, kind: str, side_w: list[str], side_l: list[str]):
    """Derive pair observations for one canonical match.

    side_w / side_l: resolved member id lists (x:unknown already excluded).
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

    # Source corruption: the same person listed on both sides (15 matches in the
    # audited corpus). Deriving anything for them would assert same-side AND
    # opposed in one match — drop the person from this match entirely instead.
    dual = set(side_w) & set(side_l)
    if dual:
        sup["dual_side_members_suppressed"] = len(dual)
        side_w = [m for m in side_w if m not in dual]
        side_l = [m for m in side_l if m not in dual]

    cross_rel = REL_BR if form == "battle_royal" else REL_OPPOSED
    for a in side_w:
        for b in side_l:
            obs.append((cross_rel, a, b) if a < b else (cross_rel, b, a))

    def partners(side: list[str]) -> None:
        for i in range(len(side)):
            for j in range(i + 1, len(side)):
                a, b = side[i], side[j]
                obs.append((REL_SAME, a, b) if a < b else (REL_SAME, b, a))

    if form in _TEAM_FORMS:
        partners(side_w)
        partners(side_l)
    elif form == "multi_way":
        if kind == "decisive":
            partners(side_w)  # the side that genuinely won together
            sup["multiway_loser_pairs_suppressed"] += _within_pairs(len(side_l))
        else:
            # no winner side exists: both rows may be collapsed groups
            sup["multiway_draw_pairs_suppressed"] += _within_pairs(len(side_w))
            sup["multiway_draw_pairs_suppressed"] += _within_pairs(len(side_l))
    elif form == "battle_royal":
        sup["battle_royal_partner_pairs_suppressed"] += _within_pairs(len(side_w))
        sup["battle_royal_partner_pairs_suppressed"] += _within_pairs(len(side_l))
    # singles / unknown: sides are size-1 -> nothing to derive within sides

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
        side_w = rec["sides"][0]["members"]
        side_l = rec["sides"][1]["members"]
        obs, sup = derive_observations(rec["form"], rec["kind"], side_w, side_l)
        for k, v in sup.items():
            self.counters[k] += v
        if sup["dual_side_members_suppressed"]:
            self.dual_side_match_ids.append(rec["id"])
        if not obs:
            return

        form = rec["form"]
        form_bit = 1 << FORM_BITS[form]
        title_first = rec["title_components"][0] if rec["title_components"] else None
        day = rec["day"]
        mid = rec["id"]
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
                    rec["card_id"],
                    rec["promotion_id"],
                    rel,
                    form,
                    rec["res"],
                    rec["fin"],
                    title_first,
                    rec["title_change"],
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
