"""Secret scan: no credential-shaped strings in git-tracked files."""

import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

PATTERNS = [
    ("openai/anthropic key", re.compile(rb"sk-[A-Za-z0-9_-]{32,}")),
    ("aws access key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("github token", re.compile(rb"ghp_[A-Za-z0-9]{36}")),
    ("github fine-grained", re.compile(rb"github_pat_[A-Za-z0-9_]{22,}")),
    ("slack token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google api key", re.compile(rb"AIza[0-9A-Za-z_-]{35}")),
    ("private key block", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("discord bot token", re.compile(rb"[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}")),
]


def test_no_secrets_in_tracked_files():
    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
    ).stdout.split(b"\0")
    hits = []
    for rel in tracked:
        if not rel:
            continue
        p = REPO_ROOT / rel.decode("utf-8", "replace")
        if not p.is_file():
            continue
        data = p.read_bytes()
        for label, pat in PATTERNS:
            m = pat.search(data)
            if m:
                hits.append(f"{p}: {label}: {m.group(0)[:20]!r}…")
    assert not hits, "secret-shaped strings in committed files:\n" + "\n".join(hits)


def test_private_data_is_ignored():
    gitignore = (REPO_ROOT / ".gitignore").read_text()
    for needle in ("data/private/", "data/materialized/", ".env"):
        assert needle in gitignore
    # the source database itself must never be tracked
    tracked = subprocess.run(
        ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, check=True
    ).stdout.decode()
    assert ".sqlite" not in tracked
