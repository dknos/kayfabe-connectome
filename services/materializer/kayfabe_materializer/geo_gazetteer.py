"""geo-gazetteer@1 — local GeoNames reference data.

The gazetteer is FETCHED once by an explicit command and lives under
`data/private/gazetteer/` (gitignored, ~40 MB). It is a build-time input to
`geo:resolve` only. `geo:materialize` never reads it — it reads the small,
committed, reviewed `config/geo/resolved-places.json` — so a fresh clone can
rebuild the geographic projection with no network and no 40 MB download, and
tests never touch a remote service.

Source: GeoNames (https://www.geonames.org), licensed CC BY 4.0. Attribution
is required and is surfaced in the GEO lens credits, not just in this file.

Nothing here is shipped to the browser.
"""

from __future__ import annotations

import hashlib
import sys
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

from .geo_normalize import fold

GAZETTEER = Path(__file__).resolve().parents[3] / "data" / "private" / "gazetteer"
BASE_URL = "https://download.geonames.org/export/dump/"
FILES = ("cities500.zip", "admin1CodesASCII.txt", "countryInfo.txt")

# Per-country dumps carry EVERY populated place, including the sub-city wards
# and districts that host wrestling shows and that cities500 omits: Hakata and
# Kokura (wards of Fukuoka and Kitakyushu), Ybor City (a district of Tampa).
# Chosen by where the corpus actually is — Japan alone accounts for half the
# unresolved cards. They are consulted only when cities500 has no match at all,
# so adding them can never change a resolution that already succeeded.
COUNTRY_FILES = ("JP.zip", "GB.zip", "CA.zip", "DE.zip", "MX.zip", "US.zip")
GAZETTEER_VERSION = "geonames-cities500+country@2"

# cities500.txt column offsets (GeoNames "geoname" table export).
C_ID, C_NAME, C_ASCII, C_ALT = 0, 1, 2, 3
C_LAT, C_LON = 4, 5
C_FCLASS, C_FCODE, C_COUNTRY = 6, 7, 8
C_ADMIN1 = 10
C_POP = 14


class Place:
    """One gazetteer entry. Slots because there are 235k of them."""

    __slots__ = ("gid", "name", "ascii_name", "country", "admin1", "lat", "lon", "pop", "fcode")

    def __init__(self, gid, name, ascii_name, country, admin1, lat, lon, pop, fcode):
        self.gid = gid
        self.name = name
        self.ascii_name = ascii_name
        self.country = country
        self.admin1 = admin1
        self.lat = lat
        self.lon = lon
        self.pop = pop
        self.fcode = fcode

    @property
    def place_id(self) -> str:
        """Stable canonical id. GeoNames ids are permanent, so this survives
        a gazetteer refresh."""
        return f"g:{self.gid}"


class Gazetteer:
    """Two name indexes, deliberately kept apart.

    GeoNames' `alternatenames` column is community-maintained and contains
    outright errors: Lake Charles LA lists "Charlestown", Taguig PH lists
    "Santa Ana", Asheville NC lists "Morristown". Pooling those with the
    primary names does more than add noise — a populous impostor can win the
    population-dominance test and produce a confidently WRONG coordinate.

    So alternates are a strict fallback: if any primary name matches, only
    primary matches are considered. Alternates are consulted solely when no
    primary name matches at all (which is what makes "Mexico City" ->
    "Ciudad de México" work), and a match found that way is flagged.
    """

    def __init__(self) -> None:
        self.places: dict[int, Place] = {}
        self.by_fold: dict[str, list[int]] = {}  # cities500 primary names
        self.by_fold_local: dict[str, list[int]] = {}  # country-dump primary names
        self.by_fold_alt: dict[str, list[int]] = {}  # alternate names, either file
        self.admin1_names: dict[str, list[tuple[str, str]]] = {}  # fold -> [(country, admin1)]
        self.admin1_display: dict[str, str] = {}  # "US.FL" -> "Florida"
        self.country_names: dict[str, str] = {}  # "US" -> "United States"
        self.country_by_fold: dict[str, str] = {}

    def index(self, key: str, gid: int, tier: str = "primary") -> None:
        table = {"primary": self.by_fold, "local": self.by_fold_local,
                 "alt": self.by_fold_alt}[tier]
        bucket = table.setdefault(key, [])
        if gid not in bucket:
            bucket.append(gid)

    def candidate_tiers(self, name_fold: str) -> list[tuple[str, list["Place"]]]:
        """Non-empty candidate lists in strict tier order: a primary name in
        the major-cities file, then a primary name in a per-country dump, then
        an alternate name. Each list is sorted by descending population then
        ascending id — stable across runs, independent of file order.

        Tiers are never POOLED (an alternate name carrying a real error, like
        Lake Charles listing "Charlestown", would outrank an exact primary
        match on population). They are, however, tried in turn: a lower tier is
        consulted when a higher one yields no decisive answer, so adding a tier
        can only add coverage, never take it away."""
        out: list[tuple[str, list[Place]]] = []
        for tier, table in (("primary", self.by_fold), ("local", self.by_fold_local),
                            ("alt", self.by_fold_alt)):
            gids = table.get(name_fold)
            if gids:
                places = [self.places[g] for g in gids]
                places.sort(key=lambda p: (-p.pop, p.gid))
                out.append((tier, places))
        return out


def _is_latin(s: str) -> bool:
    """Alternate names come in every script. Only Latin-script names can ever
    match this corpus, and indexing the rest triples the index for nothing."""
    return all(ord(c) < 0x250 for c in s)


def load(root: Path | None = None) -> Gazetteer:
    root = root or GAZETTEER
    cities = root / "cities500.txt"
    if not cities.exists():
        raise FileNotFoundError(
            f"gazetteer missing at {cities}. Run: pnpm geo:gazetteer:fetch"
        )
    g = Gazetteer()

    admin1 = root / "admin1CodesASCII.txt"
    if admin1.exists():
        for line in admin1.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            code, name = parts[0], parts[1]
            country, _, a1 = code.partition(".")
            g.admin1_display[code] = name
            for variant in (parts[1], parts[2]):
                g.admin1_names.setdefault(fold(variant), []).append((country, a1))

    info = root / "countryInfo.txt"
    if info.exists():
        for line in info.read_text(encoding="utf-8").splitlines():
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 5:
                continue
            iso, name = parts[0], parts[4]
            g.country_names[iso] = name
            g.country_by_fold[fold(name)] = iso

    def ingest(path: Path, tier: str) -> None:
        with path.open(encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) < 15:
                    continue
                # Populated places only. A country dump also contains rivers,
                # peaks and parks, and a stream named "Tokyo" must never be a
                # candidate for a city named Tokyo.
                if p[C_FCLASS] != "P":
                    continue
                try:
                    gid = int(p[C_ID])
                    lat, lon = float(p[C_LAT]), float(p[C_LON])
                    pop = int(p[C_POP] or 0)
                except ValueError:
                    continue
                known = gid in g.places
                if not known:
                    g.places[gid] = Place(gid, p[C_NAME], p[C_ASCII], p[C_COUNTRY],
                                          p[C_ADMIN1], lat, lon, pop, p[C_FCODE])
                if known and tier == "local":
                    continue  # already indexed at the higher tier
                g.index(fold(p[C_NAME]), gid, tier)
                g.index(fold(p[C_ASCII]), gid, tier)
                for alt in p[C_ALT].split(","):
                    alt = alt.strip()
                    if alt and _is_latin(unicodedata.normalize("NFKD", alt)):
                        k = fold(alt)
                        if k:
                            g.index(k, gid, "alt")

    ingest(cities, "primary")
    for name in COUNTRY_FILES:
        local = root / f"{name[:-4]}.txt"
        if local.exists():
            ingest(local, "local")
    return g


def fetch(root: Path | None = None) -> int:
    """Explicit, one-time, network. Never called from resolve, materialize,
    or any test."""
    root = root or GAZETTEER
    root.mkdir(parents=True, exist_ok=True)
    checksums: list[str] = []
    for name in FILES + COUNTRY_FILES:
        dest = root / name
        url = BASE_URL + name
        print(f"  fetching {url}")
        with urllib.request.urlopen(url, timeout=180) as r:  # noqa: S310 — fixed https host
            data = r.read()
        dest.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        checksums.append(f"{digest}  {name}")
        print(f"    {len(data):>10,} bytes  sha256 {digest[:16]}…")
        if name.endswith(".zip"):
            with zipfile.ZipFile(dest) as z:
                z.extractall(root)
    (root / "CHECKSUMS.txt").write_text("\n".join(checksums) + "\n", encoding="utf-8")
    (root / "LICENSE.txt").write_text(
        "GeoNames geographical database — https://www.geonames.org\n"
        "Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)\n"
        "https://creativecommons.org/licenses/by/4.0/\n\n"
        "This directory is build-time input only. It is gitignored and never\n"
        "shipped to the browser; only reviewed, resolved coordinates are.\n",
        encoding="utf-8",
    )
    print(f"  gazetteer ready at {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(fetch())
