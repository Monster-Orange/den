#!/bin/sh
# The release job's tree check: the release commit is its newest gated
# candidate (the highest v<version>-dev.N) with the release commit's own
# edits applied, and nothing else. The ancestry check (release-ancestry.sh)
# proves each candidate is in the history; this one proves nothing else came
# with it. Found when a pull request merged straight to main after the
# candidate was tagged: the ancestry check passed, and the release would have
# shipped work no gate had run.
#
#   sh scripts/release-tree.sh <version> <sha>
#
# The release commit's edits are the ones `release-dry-run.mjs apply` makes
# (the same edits the dry run and the release gates apply): Den's version in
# package.json, package-lock.json and examples/distribution/package.json, and
# the kit's version in packages/den-ui/package.json and the lockfile. They are
# applied to a copy of the candidate, with Den <version> and the kit version
# the release commit carries. CHANGELOG.md may differ freely. Any other
# difference fails, named.
#
# Exit 0: the trees match, or no candidate was tagged (a warning, as the
# ancestry check does). Exit 1: they differ (named), or the edits can't be
# applied. Exit 2: bad arguments.
set -eu
version=${1:-}
sha=${2:-}
case "$version" in
  "" | *[!0-9A-Za-z.-]*) echo "::error::usage: release-tree.sh <version> <sha>"; exit 2 ;;
esac
[ -n "$sha" ] || { echo "::error::usage: release-tree.sh <version> <sha>"; exit 2; }
git rev-parse -q --verify "$sha^{commit}" > /dev/null || { echo "::error::$sha isn't a commit here"; exit 2; }
sha=$(git rev-parse "$sha^{commit}")

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
cand=$(git rev-parse "$newest^{commit}")
short=$(git rev-parse --short "$cand")

# The kit version the release commit carries.
kit=$(git show "$sha:packages/den-ui/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')

# A copy of the candidate, with the release commit's edits applied by this
# checkout's own script (the date is any valid one: the changelog isn't compared).
here=$(cd "$(dirname "$0")" && pwd)
copy=$(mktemp -d)
trap 'git worktree remove --force "$copy" > /dev/null 2>&1 || rm -rf "$copy"' EXIT
git worktree add -q --detach "$copy" "$cand"
if ! (cd "$copy" && node "$here/release-dry-run.mjs" apply "$version" "$kit" 2000-01-01 2> /dev/null); then
  echo "::error::the release commit's edits (release-dry-run.mjs apply $version $kit) can't be applied to $newest ($short)"
  exit 1
fi

bad=""
for f in $(git -C "$copy" diff --name-only "$sha"); do
  [ "$f" = CHANGELOG.md ] || bad="$bad $f"
done
if [ -n "$bad" ]; then
  echo "::error::$sha differs from the gated candidate $newest ($short) with the release's version edits in:$bad. Release only what the gate ran: tag a new candidate with this work, or take it out of main"
  exit 1
fi
echo "$sha is $newest ($short) with the release's version edits (Den $version, kit $kit), apart from the changelog"
