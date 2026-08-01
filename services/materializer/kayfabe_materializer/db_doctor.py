"""Read-only audit of the source SQLite corpus.

Emits:
  docs/DATABASE-AUDIT.md
  docs/DATA-DICTIONARY.md
  data/private/database-profile.json
  config/schema-map.generated.yaml
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from .source_db import REPO_ROOT, connect_readonly, source_db_path

SAMPLE_LIMIT = 20000

# Semantic knowledge established during interactive verification (2026-07-31).
# Each note is a mapping-level fact the normalizer depends on.
SEMANTIC_NOTES = {
    "Wrestlers": [
        "Rows conflate PEOPLE and SIDES: names containing ' & ' are ampersand-joined "
        "participant lists (teams or collapsed multi-way opposition), not individuals.",
        "Placeholder rows exist (e.g. 'Unknown Participants') and must resolve to "
        "an unresolved-identity sentinel, never a person.",
        "Disambiguation suffixes like '(II)' distinguish successive mask/gimmick "
        "holders; they are distinct canonical people.",
    ],
    "Matches": [
        "Exactly two side references per match: winner_id and loser_id, each a single "
        "Wrestlers row id stored as TEXT (verified all-numeric, no comma lists).",
        "Multi-way matches are COLLAPSED: the losing 'side' row joins all non-winners "
        "with ' & '. Same-side (partner) observations are only valid for genuine team "
        "match forms, never for multi-way singles forms.",
        "win_type encodes result + finish: 'def. (pin|sub|DQ|CO|TKO|KO|forfeit)', "
        "'draw (NC|DCO|DDQ|time)', bare 'def.'/'draw', and 'vs.' meaning unknown result.",
        "title_id references Belts; Belts.id=1 has empty name and is the NO-TITLE "
        "sentinel. title_change is 0/1.",
        "duration is 'MM:SS' text, frequently empty.",
    ],
    "Belts": [
        "Some names are concatenation artifacts of two titles contested together "
        "(e.g. 'ECW FTW Title ECW World Heavyweight Title'); the normalizer must split "
        "them against the standalone-title name list.",
        "Belts.id=1 (empty name) is the no-title sentinel.",
    ],
    "Cards": [
        "One row per event occurrence. url is the provenance link (100% "
        "www.profightdb.com in the audited snapshot); info_html/match_html are raw "
        "scraped payloads — PRIVATE, never published or shipped to the browser.",
        "event_date is uniformly YYYY-MM-DD with zero nulls in the audited snapshot.",
    ],
    "Match_Types": [
        "Free-text stipulation strings (1,296 distinct incl. empty). The normalizer "
        "classifies them into structured form (singles/tag/multi-side/battle-royal/"
        "unknown) while preserving the original stipulation text.",
    ],
}

PRIVATE_COLUMNS = {("Cards", "info_html"), ("Cards", "match_html")}


def profile(con: sqlite3.Connection) -> dict:
    cur = con.cursor()
    meta: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dialect": "sqlite",
        "sqlite_runtime": sqlite3.sqlite_version,
        "db_path_basename": source_db_path().name,
        "access_mode": "mode=ro&immutable=1",
        "tables": {},
    }
    tables = [
        r[0]
        for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    for t in tables:
        cols = cur.execute(f'PRAGMA table_info("{t}")').fetchall()
        fks = cur.execute(f'PRAGMA foreign_key_list("{t}")').fetchall()
        idx = cur.execute(f'PRAGMA index_list("{t}")').fetchall()
        rowcount = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        sample_n = min(rowcount, SAMPLE_LIMIT)
        col_profiles = []
        for c in cols:
            name, ctype, pk = c[1], c[2], bool(c[5])
            nulls = empties = 0
            if sample_n:
                nulls = cur.execute(
                    f'SELECT COUNT(*) FROM (SELECT "{name}" v FROM "{t}" LIMIT ?) WHERE v IS NULL',
                    (sample_n,),
                ).fetchone()[0]
                empties = cur.execute(
                    f'SELECT COUNT(*) FROM (SELECT "{name}" v FROM "{t}" LIMIT ?) WHERE v = \'\'',
                    (sample_n,),
                ).fetchone()[0]
            col_profiles.append(
                {
                    "name": name,
                    "declared_type": ctype or "ANY",
                    "primary_key": pk,
                    "null_rate_sampled": round(nulls / sample_n, 4) if sample_n else None,
                    "empty_rate_sampled": round(empties / sample_n, 4) if sample_n else None,
                    "private": (t, name) in PRIVATE_COLUMNS,
                }
            )
        meta["tables"][t] = {
            "row_count": rowcount,
            "sampled_rows": sample_n,
            "columns": col_profiles,
            "declared_foreign_keys": [dict(zip(("id", "seq", "table", "from", "to", "on_update", "on_delete", "match"), f)) for f in fks],
            "indexes": [i[1] for i in idx],
            "semantic_notes": SEMANTIC_NOTES.get(t, []),
        }

    # Corpus-level facts
    meta["facts"] = {
        "date_range": list(
            cur.execute("SELECT MIN(event_date), MAX(event_date) FROM Cards").fetchone()
        ),
        "promotions": {
            str(r[0]): r[1] for r in cur.execute("SELECT id, name FROM Promotions ORDER BY id")
        },
        "cards_per_promotion": {
            str(r[0]): r[1]
            for r in cur.execute("SELECT promotion_id, COUNT(*) FROM Cards GROUP BY promotion_id")
        },
        "side_rows_in_wrestlers": cur.execute(
            "SELECT COUNT(*) FROM Wrestlers WHERE name LIKE '% & %'"
        ).fetchone()[0],
        "individual_rows_in_wrestlers": cur.execute(
            "SELECT COUNT(*) FROM Wrestlers WHERE name NOT LIKE '% & %'"
        ).fetchone()[0],
        "win_type_distribution": {
            (r[0] or ""): r[1]
            for r in cur.execute(
                "SELECT win_type, COUNT(*) FROM Matches GROUP BY win_type ORDER BY 2 DESC"
            )
        },
        "title_matches": cur.execute(
            "SELECT COUNT(*) FROM Matches WHERE CAST(title_id AS INT) != 1"
        ).fetchone()[0],
        "title_changes": cur.execute(
            "SELECT COUNT(*) FROM Matches WHERE title_change = 1"
        ).fetchone()[0],
        "orphans": {
            "matches_without_card": cur.execute(
                "SELECT COUNT(*) FROM Matches m LEFT JOIN Cards c ON c.id=m.card_id WHERE c.id IS NULL"
            ).fetchone()[0],
            "matches_bad_winner": cur.execute(
                "SELECT COUNT(*) FROM Matches m LEFT JOIN Wrestlers w ON w.id=CAST(m.winner_id AS INT) WHERE w.id IS NULL"
            ).fetchone()[0],
            "matches_bad_loser": cur.execute(
                "SELECT COUNT(*) FROM Matches m LEFT JOIN Wrestlers w ON w.id=CAST(m.loser_id AS INT) WHERE w.id IS NULL"
            ).fetchone()[0],
            "matches_bad_title": cur.execute(
                "SELECT COUNT(*) FROM Matches m LEFT JOIN Belts b ON b.id=CAST(m.title_id AS INT) WHERE b.id IS NULL"
            ).fetchone()[0],
        },
        "invalid_dates": cur.execute(
            "SELECT COUNT(*) FROM Cards WHERE event_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'"
        ).fetchone()[0],
        "provenance_url_domains": {
            (r[0] or "none"): r[1]
            for r in cur.execute(
                "SELECT substr(url, instr(url,'//')+2, 30), COUNT(*) FROM Cards GROUP BY 1"
            )
        },
        "matches_per_year": {
            r[0]: r[1]
            for r in cur.execute(
                "SELECT substr(c.event_date,1,4), COUNT(*) FROM Matches m JOIN Cards c ON c.id=m.card_id GROUP BY 1 ORDER BY 1"
            )
        },
    }
    return meta


def write_audit_md(meta: dict) -> str:
    f = meta["facts"]
    lines = [
        "# Database Audit — source corpus",
        "",
        f"Generated: {meta['generated_at']}  ",
        f"Dialect: SQLite (runtime {meta['sqlite_runtime']}) — access `{meta['access_mode']}` on a private copy.  ",
        f"File: `{meta['db_path_basename']}` (never committed).",
        "",
        "## Shape",
        "",
        "| Table | Rows | Notes |",
        "|---|---:|---|",
    ]
    for t, info in meta["tables"].items():
        note = info["semantic_notes"][0] if info["semantic_notes"] else ""
        lines.append(f"| {t} | {info['row_count']:,} | {note[:110]} |")
    lines += [
        "",
        "## Corpus facts",
        "",
        f"- Event date range: **{f['date_range'][0]} → {f['date_range'][1]}**, {f['invalid_dates']} invalid dates.",
        f"- Promotions: {', '.join(f['promotions'].values())}.",
        f"- Wrestlers rows: {f['individual_rows_in_wrestlers']:,} individual-name rows, "
        f"{f['side_rows_in_wrestlers']:,} ampersand-joined SIDE rows (teams / collapsed opposition).",
        f"- Title matches: {f['title_matches']:,}; title changes: {f['title_changes']:,}.",
        f"- Referential integrity: {sum(f['orphans'].values())} orphan references across all checked joins.",
        f"- Provenance: card URLs resolve to {', '.join(sorted(set(d.split('/')[0] for d in f['provenance_url_domains'])))}.",
        "",
        "## Result / finish taxonomy (win_type)",
        "",
        "| win_type | count |",
        "|---|---:|",
    ]
    for k, v in f["win_type_distribution"].items():
        lines.append(f"| `{k or '(empty)'}` | {v:,} |")
    lines += [
        "",
        "## Hazards the normalizer MUST respect",
        "",
    ]
    for t, notes in SEMANTIC_NOTES.items():
        for n in notes:
            lines.append(f"- **{t}**: {n}")
    lines += [
        "",
        "## Read-only guarantee",
        "",
        "All access uses `mode=ro&immutable=1`; `guard_sql` additionally blocks DML/DDL verbs. "
        "No migration, index, or repair statement targets the source.",
        "",
    ]
    return "\n".join(lines)


def write_dictionary_md(meta: dict) -> str:
    lines = ["# Data Dictionary — source corpus", ""]
    for t, info in meta["tables"].items():
        lines += [f"## {t} ({info['row_count']:,} rows)", ""]
        lines += ["| Column | Type | PK | Null% | Empty% | Private |", "|---|---|---|---:|---:|---|"]
        for c in info["columns"]:
            nr = "—" if c["null_rate_sampled"] is None else f"{100*c['null_rate_sampled']:.1f}"
            er = "—" if c["empty_rate_sampled"] is None else f"{100*c['empty_rate_sampled']:.1f}"
            lines.append(
                f"| {c['name']} | {c['declared_type']} | {'✓' if c['primary_key'] else ''} | {nr} | {er} | {'PRIVATE' if c['private'] else ''} |"
            )
        for n in info["semantic_notes"]:
            lines.append(f"\n> {n}")
        lines.append("")
    return "\n".join(lines)


def write_schema_map_yaml(meta: dict) -> str:
    """Canonical-field ← source-column proposal. Hand-refined copy lives in config/schema-map.yaml."""
    y = [
        "# GENERATED by db_doctor — proposal only. Refined copy: config/schema-map.yaml",
        f"source_schema_version: {meta['db_path_basename']}",
        "dialect: sqlite",
        "entities:",
        "  person:",
        "    source: Wrestlers",
        "    where: \"name NOT LIKE '% & %' AND name NOT IN (placeholder_names)\"",
        "    fields:",
        "      source_person_id: {column: id, transform: none, confidence: direct}",
        "      display_name: {column: name, transform: trim, confidence: direct}",
        "    notes: disambiguation suffix '(II)' kept; placeholders -> unresolved sentinel",
        "  side_row:",
        "    source: Wrestlers",
        "    where: \"name LIKE '% & %'\"",
        "    fields:",
        "      participants: {column: name, transform: \"split(' & ') -> resolve exact name\", confidence: inferred-high}",
        "  promotion:",
        "    source: Promotions",
        "    fields: {source_promotion_id: {column: id}, name: {column: name}}",
        "  event_occurrence:",
        "    source: Cards",
        "    fields:",
        "      date: {column: event_date, transform: iso-date, confidence: direct}",
        "      event_name_id: {column: event_id, fk: Events.id}",
        "      location_id: {column: location_id, fk: Locations.id}",
        "      promotion_id: {column: promotion_id, fk: Promotions.id}",
        "      provenance_url: {column: url, publication: private-link-only}",
        "      info_html: {column: info_html, publication: PRIVATE-never-ship}",
        "      match_html: {column: match_html, publication: PRIVATE-never-ship}",
        "  match:",
        "    source: Matches",
        "    fields:",
        "      card_id: {column: card_id, fk: Cards.id}",
        "      winner_side: {column: winner_id, fk: Wrestlers.id, transform: side-expansion}",
        "      loser_side: {column: loser_id, fk: Wrestlers.id, transform: side-expansion}",
        "      result: {column: win_type, transform: result-finish-parse}",
        "      match_form: {column: match_type_id, fk: Match_Types.id, transform: form-classify}",
        "      duration_seconds: {column: duration, transform: mmss-or-null}",
        "      title_id: {column: title_id, fk: Belts.id, transform: 'sentinel 1 -> none'}",
        "      title_change: {column: title_change, transform: bool}",
        "  championship:",
        "    source: Belts",
        "    where: \"id != 1\"",
        "    fields: {source_belt_id: {column: id}, name: {column: name, transform: concat-artifact-split}}",
        "hazards:",
        "  - multi-way collapse: partner observations only for team forms",
        "  - battle royals: low-weight opposed observations, no partner edges",
        "  - 'Unknown Participants' and kin: unresolved-identity sentinel",
        "  - Belts concat artifacts: split against standalone-title list",
    ]
    return "\n".join(y) + "\n"


def main() -> None:
    con = connect_readonly()
    meta = profile(con)
    con.close()

    (REPO_ROOT / "docs" / "DATABASE-AUDIT.md").write_text(write_audit_md(meta))
    (REPO_ROOT / "docs" / "DATA-DICTIONARY.md").write_text(write_dictionary_md(meta))
    (REPO_ROOT / "data" / "private").mkdir(parents=True, exist_ok=True)
    (REPO_ROOT / "data" / "private" / "database-profile.json").write_text(
        json.dumps(meta, indent=1)
    )
    (REPO_ROOT / "config" / "schema-map.generated.yaml").write_text(write_schema_map_yaml(meta))
    print("db:doctor OK —",
          f"{len(meta['tables'])} tables,",
          f"dates {meta['facts']['date_range'][0]}..{meta['facts']['date_range'][1]},",
          f"orphans={sum(meta['facts']['orphans'].values())}")


if __name__ == "__main__":
    main()
