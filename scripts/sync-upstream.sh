#!/usr/bin/env bash
# Re-sync skills/ from upstream K-Dense-AI/scientific-agent-skills.
# Usage: bash scripts/sync-upstream.sh [tag|main]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

UPSTREAM="https://github.com/K-Dense-AI/scientific-agent-skills"

if [[ -z "$REF" ]]; then
  # Latest release tag, else main.
  REF="$(git ls-remote --tags --refs "$UPSTREAM" 2>/dev/null | awk -F/ '{print $3}' | sort -V | tail -1 || true)"
  REF="${REF:-main}"
fi

echo "Fetching upstream $UPSTREAM @ $REF ..."
cd "$TMP"
# No --filter: the checkout needs every blob anyway, so a partial clone just
# refetches them on demand for the same bytes plus an extra round trip.
git clone --depth 1 --branch "$REF" "$UPSTREAM" upstream >/dev/null 2>&1
cd upstream

# Snapshot the previous skill set for the diff report.
find "$REPO_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$TMP/old.txt"
find skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$TMP/new.txt"

# Replace wholesale — delete removed/renamed skills, copy everything fresh.
rm -rf "$REPO_ROOT/skills"
cp -R skills "$REPO_ROOT/skills"

echo
echo "Synced skills/ from $REF:"
echo "  removed: $(comm -23 "$TMP/old.txt" "$TMP/new.txt" | wc -l | tr -d ' ')"
echo "  added:   $(comm -13 "$TMP/old.txt" "$TMP/new.txt" | wc -l | tr -d ' ')"
comm -23 "$TMP/old.txt" "$TMP/new.txt" | sed 's/^/    removed: /'
comm -13 "$TMP/old.txt" "$TMP/new.txt" | sed 's/^/    added:   /'

if [[ "$REF" != "main" ]]; then
  echo "Upstream version: $REF (mirror in package.json)"
else
  echo "Synced from main (untagged). Consider pinning a release tag."
fi

echo
echo "Next: npm run validate, spot-check with 'pi -e .', bump package.json version, commit."
