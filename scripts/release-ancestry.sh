#!/bin/sh
# The release job's ancestry check: every gated candidate of <version> (its
# tags v<version>-dev.N, pushed when a candidate is packed for a gate) is in
# <sha>'s history. A candidate that passed its gate but never merged would
# otherwise ship as nothing while its version goes to other work.
#
#   sh scripts/release-ancestry.sh <version> <sha>
#
# Exit 0: every candidate is in, or none was tagged (a warning). Exit 1: one
# or more is not (named). Exit 2: bad arguments.
set -eu
version=${1:-}
sha=${2:-}
case "$version" in
  "" | *[!0-9A-Za-z.-]*) echo "::error::usage: release-ancestry.sh <version> <sha>"; exit 2 ;;
esac
[ -n "$sha" ] || { echo "::error::usage: release-ancestry.sh <version> <sha>"; exit 2; }
git rev-parse -q --verify "$sha^{commit}" > /dev/null || { echo "::error::$sha isn't a commit here"; exit 2; }

tags=$(git tag -l "v$version-dev.*")
if [ -z "$tags" ]; then
  echo "::warning::no gated candidate tagged for $version (v$version-dev.N): nothing to check"
  exit 0
fi
missing=""
for t in $tags; do
  if git merge-base --is-ancestor "$t^{commit}" "$sha"; then
    echo "$t ($(git rev-parse --short "$t^{commit}")) is in $sha's history"
  else
    missing="$missing $t($(git rev-parse --short "$t^{commit}"))"
  fi
done
if [ -n "$missing" ]; then
  echo "::error::gated candidate(s)$missing isn't in the history of $sha: merge them into main, or say why not, before releasing $version"
  exit 1
fi
