#!/bin/sh
# Issue 922: may <commit> be released? A release publishes the exact tree of
# the dev tag that passed its test bed, never main's HEAD. The promoted
# commit is the release's version commit (on its release branch):
#
#   - its package.json version V is a release (no -suffix), and npm doesn't
#     have V yet;
#   - its first parent carries the dev tag vV-dev.N: an annotated tag signed
#     by a key in $RELEASE_SIGNERS (default .github/release-signers, an SSH
#     allowed-signers file, read from the commit this script runs from);
#   - that parent has the bed's PASS: its newest commit status whose context
#     is $RELEASE_BED_CONTEXT (default release/bed) is success, and was set by
#     a tester listed in $RELEASE_BED_CREATORS (logins, comma or space
#     separated; a repository secret, and no login is ever printed: one can
#     be a person's own account, and the logs are public). docs/releasing.md;
#   - it changes only the version (scripts/release-version-diff.mjs), so its
#     tree is the dev tag's;
#   - vV tags no other commit (a tag is never moved);
#   - a UI kit it publishes has next/queue's kit files when next/queue has
#     the same kit version (scripts/kit-version.mjs queue; KIT_QUEUE_REF
#     names another ref than origin/next/queue).
#
#   sh scripts/release-promote.sh <commit>
#
# Needs GITHUB_REPOSITORY, and `gh` signed in (GH_TOKEN). Writes release=true,
# version, ref, dev_tag and dev_sha to $GITHUB_OUTPUT (stdout without it).
# Exit 0: promote it. Exit 1: refused (why, as ::error::). Exit 2: bad arguments.
set -eu

context=${RELEASE_BED_CONTEXT:-release/bed}
signers=${RELEASE_SIGNERS:-.github/release-signers}
creators=$(printf '%s' "${RELEASE_BED_CREATORS:-}" | tr ',' ' ')
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

# Its name is a dev tag of V, and the tag object's own name is that name: a
# signed tag pushed again under another name still verifies, so an older
# tested tree could otherwise ship as a new version.
printf '%s\n' "$dev_tag" | grep -Eq "^v$(printf '%s' "$version" | sed 's/\./\\./g')-dev\.[0-9]+\$" ||
  fail "$dev_tag isn't a dev tag of $version (v$version-dev.N)"

# Signed: an annotated tag, by a key the allowed-signers file lists.
[ "$(git cat-file -t "refs/tags/$dev_tag")" = tag ] || fail "$dev_tag is a lightweight tag: a candidate is an annotated, signed tag"
own=$(git for-each-ref --format='%(tag)' "refs/tags/$dev_tag")
[ "$own" = "$dev_tag" ] || fail "the tag at refs/tags/$dev_tag was made as $own: a tag pushed under another name isn't a candidate"
[ -f "$signers" ] || fail "no allowed-signers file at $signers: no tag can be checked"
git -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$dev_tag" > /dev/null 2>&1 ||
  fail "$dev_tag isn't signed by a key in $signers: a candidate's tag must be signed by an allowed key"

# The bed's PASS on the candidate's commit, from a listed tester.
[ -n "$(echo $creators)" ] || fail "the repository secret RELEASE_BED_CREATORS lists no tester: no PASS can count"
# The statuses list (newest first, each with its creator): the combined
# /status endpoint names no creator.
statuses=$(gh api "repos/$repo/commits/$parent/statuses?per_page=100" 2> /dev/null) || fail "GitHub couldn't be asked for $dev_tag's statuses"
set -- $(printf '%s' "$statuses" | CTX="$context" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const all = JSON.parse(s);
  if (!Array.isArray(all)) throw new Error("not a status list");
  const x = all.find((t) => t.context === process.env.CTX);
  console.log(x ? `${x.state} ${x.creator?.login ?? "?"}` : "none -");
});') || fail "GitHub's statuses for $dev_tag couldn't be read"
state=$1
by=$2
[ "$state" = success ] || fail "$dev_tag ($(git rev-parse --short "$parent")) has no PASS: its $context status is $state, not success"
case " $creators " in
  *" $by "*) ;;
  *) fail "$dev_tag's $context PASS isn't from a listed tester (RELEASE_BED_CREATORS)" ;;
esac

# Only the version changed since the dev tag.
node "$(dirname "$0")/release-version-diff.mjs" "$parent" "$sha" "$version" || exit 1

# vV is never moved.
tagged=$(git rev-parse -q --verify "refs/tags/v$version^{commit}" 2> /dev/null || true)
if [ -n "$tagged" ] && [ "$tagged" != "$sha" ]; then
  fail "v$version already tags $(git rev-parse --short "$tagged"), not $(git rev-parse --short "$sha"): not published again"
fi

# npm doesn't have V yet (npm refuses a version twice).
err=$(mktemp)
trap 'rm -f "$err"' EXIT
if found=$(npm view "$name@$version" version 2> "$err"); then
  [ "$found" != "$version" ] || fail "$name@$version is already on npm"
elif ! grep -q E404 "$err"; then
  cat "$err"
  fail "npm couldn't be asked about $name@$version"
fi

# Issue 1508: a kit it publishes carries next/queue's kit files at that version.
node "$(dirname "$0")/kit-version.mjs" queue "$sha" || exit 1

{
  echo "release=true"
  echo "version=$version"
  echo "ref=$sha"
  echo "dev_tag=$dev_tag"
  echo "dev_sha=$parent"
} >> "$out"
echo "promote $sha as v$version: the tree of $dev_tag ($(git rev-parse --short "$parent")), which has its $context PASS"
