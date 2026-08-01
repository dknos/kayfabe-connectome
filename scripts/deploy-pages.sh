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
# Make a mid-script failure loud rather than a silent early exit.
trap 'rc=$?; [ $rc -ne 0 ] && echo "deploy failed at line $LINENO (exit $rc)" >&2' ERR

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

# Refuse to publish credentials. This artifact is public and irreversible once
# indexed, so the check blocks rather than warns.
#
# Two different scans, because one pattern cannot serve both halves:
#
#   The corpus is ours, so a KEY NAME appearing there would be a real leak.
#   The JS bundles are third-party and minified, where `password:!0` is an
#   object property in a zip library, not a secret — scanning key names there
#   only produces false positives (it blocked the first run on exactly that).
#   Bundles are therefore scanned for credential VALUES: the token shapes that
#   cannot occur by accident.
SECRET_VALUES='AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,}|sk-[0-9A-Za-z]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
SECRET_KEYS='(api[_-]?key|secret|password|bearer|authorization)[\"'"'"' ]*[:=][\"'"'"' ]*[A-Za-z0-9_-]{12,}'

if hit=$(grep -rlIE "$SECRET_KEYS" "$STAGE/data" 2>/dev/null | head -3) && [ -n "$hit" ]; then
  echo "refusing to publish: credential-shaped assignment in the corpus:" >&2
  echo "$hit" >&2
  exit 1
fi
# CesiumJS bakes its own public demo Ion token into every distribution
# (sub "CesiumJS", iss api.cesium.com). It is not ours and cannot be removed
# from the vendored bundle, so it is allowlisted BY VALUE rather than by
# weakening the pattern — anything else that looks like a token still blocks.
# The engine additionally clears Ion.defaultAccessToken at runtime.
CESIUM_PUBLIC_JWT='eyJqdGkiOiIzNzRjZTkzNC05M2UwLTRlNDItOWU0My1hYjk5YjFiN'
if leaked=$(grep -rhoIE "$SECRET_VALUES" "$STAGE" 2>/dev/null \
            | grep -v "$CESIUM_PUBLIC_JWT" | sort -u | head -3) && [ -n "$leaked" ]; then
  echo "refusing to publish: credential VALUE found in the artifact:" >&2
  echo "$leaked" | cut -c1-60 >&2
  exit 1
fi
# Raw source HTML must never ship — the sqlite carries info_html/match_html.
if hit=$(grep -rlIE "<(table|tr|td|script)\b" "$STAGE/data" 2>/dev/null | head -3) && [ -n "$hit" ]; then
  echo "refusing to publish: raw source HTML in the corpus:" >&2
  echo "$hit" >&2
  exit 1
fi
echo "safety scan clean"

SHA="$(git rev-parse --short HEAD)"
git worktree add --detach "$WORKTREE" >/dev/null
cd "$WORKTREE"
# A uniquely named orphan pushed to gh-pages, rather than checking out a branch
# called gh-pages: a leftover local branch of that name — or one checked out in
# another worktree — makes `checkout --orphan gh-pages` fail, and with `set -e`
# that aborts the deploy after the build with no visible reason.
BRANCH="deploy-$$"
git checkout --orphan "$BRANCH"
git rm -rq --cached . 2>/dev/null || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$STAGE/." .
git add -A
git commit -qm "Deploy: Kayfabe Connectome demo

Built from $SHA with KAYFABE_BASE=$BASE.
Single orphan commit: this branch is a build artifact and carries no history."
git push -f origin "HEAD:gh-pages"
echo "deployed $SHA -> https://dknos.github.io${BASE}"
