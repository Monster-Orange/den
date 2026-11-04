#!/bin/bash
#
# Create a GitHub release from the CHANGELOG.md entry for a version.
#
# Usage:
#   scripts/create-release.sh                    # release current version from package.json
#   scripts/create-release.sh 1.1.5              # release a specific version
#   scripts/create-release.sh 1.1.5 abc123       # release at a specific commit SHA
#   scripts/create-release.sh --backfill-all     # create releases for all changelog versions
#
# Requires: gh CLI authenticated, CHANGELOG.md in Keep a Changelog format.

set -euo pipefail

CHANGELOG="CHANGELOG.md"

# Extract the changelog body for a given version
extract_notes() {
  local ver="$1"
  python3 -c "
import re, sys
with open('$CHANGELOG') as f:
    content = f.read()
lines = content.split('\n')
capture = False
result = []
for line in lines:
    if re.match(r'^## \[' + re.escape('$ver') + r'\]', line):
        capture = True
        continue
    if capture:
        if line.strip() == '---' or (re.match(r'^## \[', line) and len(result) > 0):
            break
        result.append(line)
# Strip leading/trailing blank lines
while result and not result[0].strip():
    result.pop(0)
while result and not result[-1].strip():
    result.pop()
print('\n'.join(result))
"
}

create_release() {
  local ver="$1"
  local target="${2:-}"
  local tag="v${ver}"

  # Check if release already exists
  if gh release view "$tag" &>/dev/null; then
    echo "  ✓ $tag already exists — skipping"
    return
  fi

  local notes
  notes=$(extract_notes "$ver")
  if [ -z "$notes" ]; then
    echo "  ✗ No changelog entry found for $ver"
    return 1
  fi

  local target_flag=""
  if [ -n "$target" ]; then
    target_flag="--target $target"
  fi

  # Determine if this is a pre-1.0 or old release (mark as not latest)
  local latest_flag=""
  local current_ver
  current_ver=$(node -p "require('./package.json').version")
  if [ "$ver" != "$current_ver" ]; then
    latest_flag="--latest=false"
  fi

  echo "  Creating $tag..."
  # shellcheck disable=SC2086
  gh release create "$tag" \
    --title "$tag" \
    --notes "$notes" \
    $target_flag \
    $latest_flag

  echo "  ✓ $tag created"
}

# ── Backfill all versions ────────────────────────────────────────────────────
if [ "${1:-}" = "--backfill-all" ]; then
  echo "Backfilling releases from CHANGELOG.md..."
  echo ""

  # Extract all versions from changelog (oldest first)
  versions=$(grep -oE '## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -r)

  for ver in $versions; do
    # Try to find the commit for this version
    sha=$(git log --all --oneline --grep="v${ver}" --format="%H" | head -1)
    if [ -z "$sha" ]; then
      sha=$(git log --all --oneline --grep="${ver}" --format="%H" | head -1)
    fi
    create_release "$ver" "${sha:-}"
  done

  echo ""
  echo "Done."
  exit 0
fi

# ── Single version release ───────────────────────────────────────────────────
VERSION="${1:-$(node -p "require('./package.json').version")}"
TARGET="${2:-}"

echo "Creating release for v${VERSION}..."
create_release "$VERSION" "$TARGET"
