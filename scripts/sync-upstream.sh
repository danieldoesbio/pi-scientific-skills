#!/usr/bin/env bash
# Re-sync skills/ from upstream K-Dense-AI/scientific-agent-skills.
# Usage: bash scripts/sync-upstream.sh [tag|main|<40-hex-commit-sha>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

UPSTREAM="https://github.com/K-Dense-AI/scientific-agent-skills"

# Skills we deliberately do not redistribute — see scripts/excluded-skills.txt
# for the licensing rationale. Comment lines and blanks are ignored.
#
# A `while read` loop, not `mapfile`: the latter is bash >= 4 only, and macOS
# still ships 3.2 as `/bin/bash`.
EXCLUDED_SKILLS=()
while IFS= read -r skill; do
  EXCLUDED_SKILLS+=("$skill")
done < <(grep -v '^#' "$REPO_ROOT/scripts/excluded-skills.txt" | grep -v '^[[:space:]]*$')

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# Latest release tag by semver, or empty if the remote has none / is unreachable.
latest_tag() {
  git ls-remote --tags --refs "$UPSTREAM" 2>/dev/null | awk -F/ '{print $3}' | sort -V | tail -1
}

if [[ -z "$REF" ]]; then
  REF="$(latest_tag || true)"
  REF="${REF:-main}"
fi

echo "Fetching upstream $UPSTREAM @ $REF ..."
cd "$TMP"

if is_sha "$REF"; then
  # `git clone --depth 1 --branch` cannot take a raw SHA — only a ref a remote
  # advertises by name. A direct fetch of the SHA itself works instead.
  git init -q upstream
  git -C upstream remote add origin "$UPSTREAM"
  git -C upstream fetch --depth 1 origin "$REF"
  git -C upstream checkout -q FETCH_HEAD
else
  # No --filter: the checkout needs every blob anyway, so a partial clone just
  # refetches them on demand for the same bytes plus an extra round trip.
  git clone --depth 1 --branch "$REF" "$UPSTREAM" upstream
fi
cd upstream

[[ -d skills ]] || {
  echo "upstream checkout has no skills/ — aborting before touching $REPO_ROOT/skills" >&2
  exit 1
}

UPSTREAM_COMMIT="$(git rev-parse HEAD)"
if is_sha "$REF"; then
  # Not a tag itself, so the version this snapshot belongs to is whatever tag
  # is newest right now; the commit above says exactly what was actually taken.
  UPSTREAM_VERSION="$(latest_tag || true)"
  UPSTREAM_VERSION="${UPSTREAM_VERSION:-$REF}"
else
  UPSTREAM_VERSION="$REF"
fi

# Warn, never act, when a tag has drifted from main: a maintainer decides
# whether to sync the tag as-is or move to a SHA on main instead.
if [[ "$REF" != "main" ]] && ! is_sha "$REF"; then
  git fetch --depth=50 origin main -q || true
  if AHEAD="$(git rev-list --count HEAD..FETCH_HEAD 2>/dev/null)"; then
    if [[ "$AHEAD" -gt 0 ]]; then
      echo "::warning:: upstream main is $AHEAD commit(s) ahead of $REF:"
      git log --oneline HEAD..FETCH_HEAD
    fi
  else
    echo "::warning:: upstream main is more than 50 commits ahead of $REF (outside the shallow fetch window)"
  fi
fi

# Snapshot the previous skill set for the diff report.
find "$REPO_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$TMP/old.txt"
find skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$TMP/new.txt"

# Keep the excluded names out of the diff report too, so they don't show up as
# perpetually "removed" on every single sync.
printf '%s\n' "${EXCLUDED_SKILLS[@]}" | sort > "$TMP/excluded.txt"
comm -23 "$TMP/new.txt" "$TMP/excluded.txt" > "$TMP/new.filtered.txt"
mv "$TMP/new.filtered.txt" "$TMP/new.txt"

# Replace wholesale — delete removed/renamed skills, copy everything fresh.
rm -rf "$REPO_ROOT/skills"
cp -R skills "$REPO_ROOT/skills"

for skill in "${EXCLUDED_SKILLS[@]}"; do
  rm -rf "$REPO_ROOT/skills/${skill:?}"
done

cp LICENSE.md "$REPO_ROOT/LICENSE.md"
LICENSE_SHA256="$(shasum -a 256 "$REPO_ROOT/LICENSE.md" | awk '{print $1}')"

node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const next = {
  ...pkg,
  upstreamVersion: process.argv[2],
  upstreamCommit: process.argv[3],
  licenseSha256: process.argv[4],
};
fs.writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
' "$REPO_ROOT/package.json" "$UPSTREAM_VERSION" "$UPSTREAM_COMMIT" "$LICENSE_SHA256"

echo
echo "Synced skills/ from $REF:"
echo "  removed: $(comm -23 "$TMP/old.txt" "$TMP/new.txt" | wc -l | tr -d ' ')"
echo "  added:   $(comm -13 "$TMP/old.txt" "$TMP/new.txt" | wc -l | tr -d ' ')"
comm -23 "$TMP/old.txt" "$TMP/new.txt" | sed 's/^/    removed: /'
comm -13 "$TMP/old.txt" "$TMP/new.txt" | sed 's/^/    added:   /'

echo
echo "package.json: upstreamVersion=$UPSTREAM_VERSION upstreamCommit=$UPSTREAM_COMMIT licenseSha256=$LICENSE_SHA256"
echo
echo "Next: check any drift warning above, npm run validate, spot-check with 'pi -e .', bump package.json version, commit."
