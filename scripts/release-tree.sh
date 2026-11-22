#!/bin/sh
# The release job's tree check: the release commit holds exactly what its
# newest gated candidate (the highest v<version>-dev.N) held, apart from the
# release's own files. The ancestry check (release-ancestry.sh) proves each
# candidate is in the history; this one proves nothing else came with it.
# Found when a pull request merged straight to main after the candidate was
# tagged: the ancestry check passed, and the release would have shipped work
# no gate had run.
#
#   sh scripts/release-tree.sh <version> <sha>
#
# Files the release commit may change: CHANGELOG.md, and in package.json and
# package-lock.json only lines that set a "version". Anything else differing
# from the candidate fails, named.
#
# Exit 0: the trees match, or no candidate was tagged (a warning, as the
# ancestry check does). Exit 1: they differ (named). Exit 2: bad arguments.
set -eu
version=${1:-}
sha=${2:-}
case "$version" in
  "" | *[!0-9A-Za-z.-]*) echo "::error::usage: release-tree.sh <version> <sha>"; exit 2 ;;
esac
[ -n "$sha" ] || { echo "::error::usage: release-tree.sh <version> <sha>"; exit 2; }
git rev-parse -q --verify "$sha^{commit}" > /dev/null || { echo "::error::$sha isn't a commit here"; exit 2; }

# The newest candidate: the highest N in v<version>-dev.N.
newest=""
best=-1
for t in $(git tag -l "v$version-dev.*"); do
  n=${t##*-dev.}
  case "$n" in "" | *[!0-9]*) continue ;; esac
  if [ "$n" -gt "$best" ]; then best=$n; newest=$t; fi
done
if [ -z "$newest" ]; then
  echo "::warning::no gated candidate tagged for $version (v$version-dev.N): no tree to compare"
  exit 0
fi

bad=""
for f in $(git diff --name-only "$newest^{commit}" "$sha"); do
  case "$f" in
    CHANGELOG.md) ;;
    package.json | package-lock.json)
      # Only "version" lines may change.
      other=$(git diff -U0 "$newest^{commit}" "$sha" -- "$f" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | grep -vE '^[+-][[:space:]]*"version": "[^"]*",?$' || true)
      [ -z "$other" ] || bad="$bad $f"
      ;;
    *) bad="$bad $f" ;;
  esac
done
if [ -n "$bad" ]; then
  echo "::error::$sha differs from the gated candidate $newest ($(git rev-parse --short "$newest^{commit}")) in:$bad. Release only what the gate ran: tag a new candidate with this work, or take it out of main"
  exit 1
fi
echo "$sha holds what $newest ($(git rev-parse --short "$newest^{commit}")) held, apart from the release's version and changelog"
