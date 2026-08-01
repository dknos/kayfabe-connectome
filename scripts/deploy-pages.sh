#!/usr/bin/env bash
# Publish the demo to GitHub Pages.
#
# The site is a gh-pages ORPHAN branch rebuilt from scratch each time: it is a
# build artifact, not history, so 436 MB is never accumulated commit over
# commit and main stays clean.
#
# This publishes data/materialized, which docs/DATA-BOUNDARIES.md otherwise
# keeps out of the repo. That was a deliberate call for the public demo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${KAYFABE_BASE:-/kayfabe-connectome/}"
STAGE="$(mktemp -d)"
WORKTREE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; git -C "$REPO_ROOT" worktree remove -f "$WORKTREE" 2>/dev/null || true' EXIT

cd "$REPO_ROOT"
[ -f data/materialized/manifest.json ] || {
  echo "data/materialized is missing — run: pnpm data:materialize && pnpm geo:materialize" >&2
  exit 1
}

echo "building with base $BASE"
KAYFABE_BASE="$BASE" pnpm --filter @kayfabe/web build

echo "staging site + corpus"
cp -r apps/web/dist/. "$STAGE/"
cp -r data/materialized "$STAGE/data"
touch "$STAGE/.nojekyll"
du -sh "$STAGE"

# Refuse to publish anything credential-shaped, the same check the geo
# validator runs — this artifact is public and irreversible once indexed.
if grep -rlIE "(api[_-]?key|secret|password|bearer)[\"' ]*[:=]|AIza[0-9A-Za-z_-]{20,}" "$STAGE" >/dev/null 2>&1; then
  echo "refusing to publish: credential-shaped string found in the artifact" >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
git worktree add --detach "$WORKTREE" >/dev/null
cd "$WORKTREE"
git checkout --orphan gh-pages >/dev/null 2>&1
git rm -rq --cached . 2>/dev/null || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$STAGE/." .
git add -A
git commit -qm "Deploy: Kayfabe Connectome demo

Built from $SHA with KAYFABE_BASE=$BASE.
Single orphan commit: this branch is a build artifact and carries no history."
git push -f origin gh-pages
echo "deployed https://dknos.github.io${BASE}"
