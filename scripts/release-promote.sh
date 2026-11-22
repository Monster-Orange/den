#!/bin/sh
# Issue 922: may <commit> be released? A release publishes the exact tree of
# the dev tag that passed its test bed, never main's HEAD. The promoted
# commit is the release's version commit (on its release branch):
#
#   - its package.json version V is a release (no -suffix), and npm doesn't
#     have V yet;
#   - its first parent carries the dev tag vV-dev.N: an annotated tag that
#     GitHub verified as signed;
#   - that parent has the bed's PASS: a commit status whose context is
#     $RELEASE_BED_CONTEXT (default release/bed), in state success. A tester
#     sets it (docs/releasing.md);
#   - it changes only the version files, so its tree is the dev tag's;
#   - vV tags no other commit (a tag is never moved).
#
#   sh scripts/release-promote.sh <commit>
#
# Needs GITHUB_REPOSITORY, and `gh` signed in (GH_TOKEN). Writes release=true,
# version, ref, dev_tag and dev_sha to $GITHUB_OUTPUT (stdout without it).
# Exit 0: promote it. Exit 1: refused (why, as ::error::). Exit 2: bad arguments.
set -eu

# The files a version commit may change (CONTRIBUTING › Releasing: Den's version and the changelog entry;
# the kit's version is decided in the candidate): everything else is the dev tag's.
VERSION_FILES="package.json package-lock.json CHANGELOG.md examples/distribution/package.json"
context=${RELEASE_BED_CONTEXT:-release/bed}
out=${GITHUB_OUTPUT:-/dev/stdout}
repo=${GITHUB_REPOSITORY:-}

fail() {
  echo "::error::$*"
  exit 1
}

c=${1:-}
[ -n "$c" ] || { echo "::error::usage: release-promote.sh <commit>"; exit 2; }
[ -n "$repo" ] || { echo "::error::GITHUB_REPOSITORY isn't set"; exit 2; }
sha=$(git rev-parse -q --verify "$c^{commit}" 2> /dev/null) || {
  echo "::error::$c isn't a commit here"
  exit 2
}

pkg() { git show "$1:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p[process.argv[1]]??"")})' "$2"; }
version=$(pkg "$sha" version)
name=$(pkg "$sha" name)
case "$version" in
  "" | *[!0-9A-Za-z.-]*) fail "$sha: no version in package.json" ;;
  *-*) fail "$version is a prerelease: only a release version is promoted" ;;
esac

parent=$(git rev-parse -q --verify "$sha^1" 2> /dev/null) || fail "$sha has no parent: it can't be a dev tag's version commit"
# The newest dev tag of V on the parent.
dev_tag=$(git tag --points-at "$parent" -l "v$version-dev.*" | sort -t. -k4,4n | tail -n 1)
[ -n "$dev_tag" ] || fail "$sha's parent $(git rev-parse --short "$parent") carries no dev tag v$version-dev.N: only a tested candidate's version commit is released"

# Signed: an annotated tag GitHub verified.
[ "$(git cat-file -t "refs/tags/$dev_tag")" = tag ] || fail "$dev_tag is a lightweight tag: a candidate is an annotated, signed tag"
obj=$(git rev-parse "refs/tags/$dev_tag")
verified=$(gh api "repos/$repo/git/tags/$obj" --jq .verification.verified 2> /dev/null || echo unknown)
[ "$verified" = true ] || fail "$dev_tag isn't signed (GitHub's verification: $verified): a candidate's tag must be signed"

# The bed's PASS on the candidate's commit.
state=$(gh api "repos/$repo/commits/$parent/status" --jq "[.statuses[] | select(.context == \"$context\")][0].state // \"none\"" 2> /dev/null || echo unknown)
[ "$state" = success ] || fail "$dev_tag ($(git rev-parse --short "$parent")) has no PASS: its $context status is $state, not success"

# Only the version files changed since the dev tag.
extra=""
for f in $(git diff --name-only "$parent" "$sha"); do
  case " $VERSION_FILES " in
    *" $f "*) ;;
    *) extra="$extra $f" ;;
  esac
done
[ -z "$extra" ] || fail "$sha changes more than the version files since $dev_tag:$extra. Those changes weren't tested: cut a new dev tag"

# vV is never moved.
tagged=$(git rev-parse -q --verify "refs/tags/v$version^{commit}" 2> /dev/null || true)
if [ -n "$tagged" ] && [ "$tagged" != "$sha" ]; then
  fail "v$version already tags $(git rev-parse --short "$tagged"), not $(git rev-parse --short "$sha"): not published again"
fi

# npm doesn't have V yet (npm refuses a version twice).
if found=$(npm view "$name@$version" version 2> npm-view.err); then
  [ "$found" != "$version" ] || fail "$name@$version is already on npm"
elif ! grep -q E404 npm-view.err; then
  cat npm-view.err
  fail "npm couldn't be asked about $name@$version"
fi
rm -f npm-view.err

{
  echo "release=true"
  echo "version=$version"
  echo "ref=$sha"
  echo "dev_tag=$dev_tag"
  echo "dev_sha=$parent"
} >> "$out"
echo "promote $sha as v$version: the tree of $dev_tag ($(git rev-parse --short "$parent")), which has its $context PASS"
