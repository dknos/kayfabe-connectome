"""Normalization primitives for the Kayfabe Connectome materializer.

Versioned algorithms implemented here (names are contract-level):
  - result/finish parse  (win_type)
  - form-classify@1      (docs/CANONICAL-MODEL.md "Match-form classification")
  - exact-name-split@1   (side-row splitter + resolution)
  - belt-split@1         (concat-artifact championship splitting)
  - day encoding         (days since 1950-01-01)
  - fnv1a32              (bucketing/slug hash, byte-wise over UTF-8)

Everything is deterministic and stdlib-only.
"""

from __future__ import annotations

import re
from datetime import date

# ---------------------------------------------------------------- fnv / days

FNV_OFFSET = 2166136261
FNV_PRIME = 16777619

UNKNOWN_ID = "x:unknown"


def fnv1a32(s: str) -> int:
    """FNV-1a 32-bit over the UTF-8 bytes of s (per MATERIALIZED-FORMAT.md)."""
    h = FNV_OFFSET
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * FNV_PRIME) & 0xFFFFFFFF
    return h


def bucket_of(key: str) -> str:
    """Two-hex-digit bucket: fnv1a32(key) % 256."""
    return "%02x" % (fnv1a32(key) % 256)


def pair_key(a: str, b: str) -> str:
    """Canonical pair key: ids sorted lexicographically, joined by '|'."""
    return f"{a}|{b}" if a < b else f"{b}|{a}"


EPOCH_ORDINAL = date(1950, 1, 1).toordinal()


def iso_to_day(iso: str) -> int:
    """ISO YYYY-MM-DD -> days since 1950-01-01."""
    return date(int(iso[0:4]), int(iso[5:7]), int(iso[8:10])).toordinal() - EPOCH_ORDINAL


def day_to_iso(day: int) -> str:
    """Days since 1950-01-01 -> ISO YYYY-MM-DD."""
    return date.fromordinal(EPOCH_ORDINAL + day).isoformat()


# ------------------------------------------------------------ win_type parse

# Finishes that imply a draw when the result token is missing (bare '(NC)').
_DRAW_FINISHES = {"NC", "DCO", "DDQ", "time", "curfew", "DPin", "DTKO", "points"}
_PAREN = re.compile(r"\(([^)]*)\)")


def parse_win_type(raw: str | None) -> tuple[str, str, str | None]:
    """Parse a win_type string.

    Returns (kind, res, fin):
      kind ∈ {'decisive', 'draw', 'unknown'}
      res  ∈ {'def.', 'draw', 'vs.', ''}   (canonical result token)
      fin  = parenthetical finish text verbatim, or None
    Rules per CANONICAL-MODEL.md:
      'def.' -> decisive; 'draw' -> draw (incl. merged 'def.draw' -> draw);
      'vs.' / empty -> unknown. Bare parenthetical finishes ('(pin)') infer
      the kind from the finish token.
    """
    s = (raw or "").strip()
    m = _PAREN.search(s)
    fin = m.group(1).strip() if m else None
    if fin == "":
        fin = None
    head = (s[: m.start()] if m else s).strip()
    hl = head.lower()

    if "draw" in hl:
        kind = "draw"
    elif hl.startswith("def"):
        kind = "decisive"
    elif hl == "" and fin is not None:
        kind = "draw" if fin in _DRAW_FINISHES else "decisive"
    else:
        kind = "unknown"

    if kind == "decisive":
        res = "def."
    elif kind == "draw":
        res = "draw"
    else:
        res = "vs." if hl == "vs." else ""
    return kind, res, fin


# ----------------------------------------------------------- form-classify@1

# Multi-way markers. Matching happens against the lowercased stipulation with
# hyphens normalized to spaces, so 'three-way', 'triple-threat', '3-way',
# '5-way' etc. are all recognized (spelling variants of the same markers).
_MULTI_SUBSTRINGS = (
    "three way",
    "triple threat",
    "four way",
    "five way",
    "six way",
    "elimination chamber",
)
_MULTI_WORDS = re.compile(r"\b(?:fatal|gauntlet|dance)\b")
_N_WAY = re.compile(r"\b\d+ way\b")
_RUMBLE = re.compile(r"\brumble\b")
_BATTLE_ROYAL = "battle royal"
_TAG = re.compile(r"\btag\b")
_N_MAN_PERSON = re.compile(r"\b\d+ (?:man|person)\b")
_HANDICAP = "handicap"

FORMS = ("singles", "tag_team", "multi_way", "battle_royal", "team_implied", "unknown")
FORM_BITS = {
    "singles": 0,
    "tag_team": 1,
    "multi_way": 2,
    "battle_royal": 3,
    "team_implied": 4,
    "unknown": 5,
}


def classify_form(stipulation: str | None, side_sizes: list[int] | tuple[int, ...]) -> str:
    """form-classify@1 — first matching rule wins (CANONICAL-MODEL.md)."""
    s = (stipulation or "").lower()
    s2 = s.replace("-", " ")
    # 1. battle royal
    if _BATTLE_ROYAL in s2 or _RUMBLE.search(s2):
        return "battle_royal"
    # 2. multi-way
    if any(t in s2 for t in _MULTI_SUBSTRINGS) or _N_WAY.search(s2) or _MULTI_WORDS.search(s2):
        return "multi_way"
    # 3. tag team
    if _TAG.search(s2) or _N_MAN_PERSON.search(s2) or _HANDICAP in s2:
        return "tag_team"
    # 4/5. by side shape
    if side_sizes and all(n == 1 for n in side_sizes):
        return "singles"
    if side_sizes and any(n > 1 for n in side_sizes):
        return "team_implied"
    # 6. otherwise
    return "unknown"


# ------------------------------------------------------------------ duration

_DURATION = re.compile(r"^(\d+):(\d{2})$")


def parse_duration(raw: str | None) -> int | None:
    """'MM:SS' -> seconds; empty/unparseable -> None."""
    s = (raw or "").strip()
    m = _DURATION.match(s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


# ------------------------------------------------------- placeholder scanner

# Placeholder-ish name patterns. Applied to every distinct name in play
# (individual rows AND side-row parts). The detected set is recorded in
# reconciliation/decisions.json.
_PLACEHOLDER = re.compile(
    r"(?i)^(?:unknown\b.*|tba|t\.b\.a\.?|to be announced|n/a|various\b.*"
    # Bare generational suffixes are scraper split-artifacts of "Name, Jr."-style
    # rows, not identities ('Jr.' alone appeared in 109 side rows and would
    # otherwise become a phantom degree-243 person). Suffixes attached to a
    # name ('Rey Misterio Jr.') are unaffected — only the bare token matches.
    r"|jr\.?|sr\.?|ii|iii|iv)$"
)


def detect_placeholders(names) -> set[str]:
    out = set()
    for n in names:
        t = str(n).strip()
        if t == "" or _PLACEHOLDER.match(t):
            out.add(str(n))
    return out


# --------------------------------------------------------- exact-name-split@1

SIDE_SEP = " & "


def split_side_name(name: str) -> list[str]:
    return name.split(SIDE_SEP)


class Resolver:
    """exact-name-split@1 — resolves Wrestlers row ids to canonical person ids.

    * individual row  -> ['p:<id>']            (state confirmed)
    * placeholder row -> []  + has_unknown     (x:unknown, never a person)
    * side row        -> each ' & '-part resolved by EXACT name match against
      individual rows; unmatched parts become derived persons
      'p:d<slug>' where slug = fnv1a32 hex (8 lowercase digits) of the exact
      part name (state probable, evidence = side row ids).
    Never fuzzy. Deterministic.
    """

    def __init__(self, wrestler_rows):
        # wrestler_rows: iterable of (id, name)
        self.rows: dict[int, str] = {int(i): str(n) for i, n in wrestler_rows}
        indiv_name_to_id: dict[str, int] = {}
        side_rows: dict[int, str] = {}
        for i in sorted(self.rows):
            n = self.rows[i]
            if SIDE_SEP in n:
                side_rows[i] = n
            else:
                # names are unique in the audited corpus; keep lowest id if not
                indiv_name_to_id.setdefault(n, i)

        all_names = set(indiv_name_to_id)
        for n in side_rows.values():
            all_names.update(split_side_name(n))
        self.placeholders: set[str] = detect_placeholders(all_names)

        self.name_to_pid = {
            n: i for n, i in indiv_name_to_id.items() if n not in self.placeholders
        }
        self.placeholder_row_ids = sorted(
            i for i in self.rows
            if SIDE_SEP not in self.rows[i] and self.rows[i] in self.placeholders
        )

        # Derived people registry (exact part name -> slug) + evidence rows.
        self.derived_slug: dict[str, str] = {}
        self.derived_rows: dict[str, list[int]] = {}
        self._slug_owner: dict[str, str] = {}
        self.unresolved_part_occurrences = 0

        # canonical resolution per row id: (members tuple, has_unknown, raw_size)
        self._resolved: dict[int, tuple[tuple[str, ...], bool, int]] = {}
        for i in sorted(self.rows):
            n = self.rows[i]
            if SIDE_SEP not in n:
                if n in self.placeholders:
                    self._resolved[i] = ((), True, 1)
                else:
                    self._resolved[i] = ((f"p:{i}",), False, 1)
                continue
            parts = split_side_name(n)
            members: list[str] = []
            has_unknown = False
            for part in parts:
                if part in self.placeholders:
                    has_unknown = True
                    self.unresolved_part_occurrences += 1
                    continue
                pid = self.name_to_pid.get(part)
                if pid is not None:
                    cid = f"p:{pid}"
                else:
                    slug = self.derived_slug.get(part)
                    if slug is None:
                        slug = "%08x" % fnv1a32(part)
                        owner = self._slug_owner.get(slug)
                        if owner is not None and owner != part:
                            raise ValueError(
                                f"fnv1a32 slug collision: {part!r} vs {owner!r}"
                            )
                        self._slug_owner[slug] = part
                        self.derived_slug[part] = slug
                    self.derived_rows.setdefault(part, []).append(i)
                    cid = f"p:d{slug}"
                if cid not in members:  # dedupe repeated names within one side
                    members.append(cid)
            self._resolved[i] = (tuple(members), has_unknown, len(parts))

    def resolve(self, row_id: int) -> tuple[tuple[str, ...], bool, int]:
        """-> (member person ids, has_unknown, raw part count)."""
        return self._resolved[int(row_id)]

    def side_name(self, row_id: int) -> str:
        return self.rows[int(row_id)]

    def derived_people(self) -> list[tuple[str, str, list[int]]]:
        """[(canonical id, exact name, sorted evidence side-row ids)] by slug."""
        out = []
        for name, slug in self.derived_slug.items():
            out.append((f"p:d{slug}", name, sorted(set(self.derived_rows[name]))))
        out.sort(key=lambda t: t[0])
        return out


# --------------------------------------------------------------- belt-split@1

NO_TITLE_BELT_ID = 1

_TITLE_SHAPED = re.compile(r"(?i)\b(?:titles?|championships?|belts?|crown)\b")


def split_belts(belts: dict[int, str]) -> dict[int, dict]:
    """belt-split@1 — classify every belt (id != 1).

    Returns {belt_id: {"kind": 'title'|'split'|'artifact',
                       "components": [belt ids],   # transitively expanded
                       "parts": [names]}}          # only for 'split'
      * 'split':    the name fully decomposes (longest-match, backtracking)
        into >= 2 names from the standalone list -> matches are attributed to
        each (deduped) component title; the concat is NOT a title node.
      * 'artifact': a standalone belt name is a proper prefix/suffix of this
        name but a full split is impossible -> kept as a single title node
        with concat_artifact flag.
      * 'title':    ordinary standalone championship.
    """
    names = {i: n for i, n in belts.items() if i != NO_TITLE_BELT_ID and n.strip() != ""}
    by_name: dict[str, int] = {}
    for i in sorted(names):
        by_name.setdefault(names[i], i)
    name_list = sorted(by_name, key=lambda n: (-len(n), n))

    def full_split(name: str):
        cands = [c for c in name_list if c != name and c in name]

        def rec(rest: str):
            if rest == "":
                return []
            for c in cands:
                if rest.startswith(c):
                    tail = rest[len(c):]
                    if tail.startswith(" "):
                        tail = tail[1:]
                    elif tail != "":
                        continue
                    sub = rec(tail)
                    if sub is not None:
                        return [c] + sub
            return None

        parts = rec(name)
        return parts if parts is not None and len(parts) >= 2 else None

    result: dict[int, dict] = {}
    for i in sorted(names):
        n = names[i]
        parts = full_split(n)
        if parts:
            comp_ids: list[int] = []
            for p in parts:
                ci = by_name[p]
                if ci not in comp_ids:
                    comp_ids.append(ci)
            result[i] = {"kind": "split", "components": comp_ids, "parts": parts}
        else:
            # Concat suspicion without a full split:
            #  * a standalone name is a proper PREFIX ('<known> <tail>'), or
            #  * a standalone name is a proper SUFFIX and the leftover head is
            #    itself title-shaped ('<X Championship> <known>'). A bare
            #    qualifier head ('Undisputed', 'Interim') is NOT a concat.
            suspected = False
            for o in name_list:
                if o == n:
                    continue
                if n.startswith(o + " "):
                    suspected = True
                    break
                if n.endswith(" " + o) and _TITLE_SHAPED.search(n[: -len(o) - 1]):
                    suspected = True
                    break
            result[i] = {
                "kind": "artifact" if suspected else "title",
                "components": [i],
                "parts": [],
            }

    # Transitive expansion: a split component that is itself split expands to
    # its own components (cycle-guarded, deterministic).
    def expand(i: int, seen: frozenset[int]) -> list[int]:
        entry = result[i]
        if entry["kind"] != "split" or i in seen:
            return [i]
        out: list[int] = []
        for c in entry["components"]:
            for e in expand(c, seen | {i}):
                if e not in out:
                    out.append(e)
        return out

    for i in sorted(result):
        if result[i]["kind"] == "split":
            result[i]["components"] = expand(i, frozenset())
    return result
