# Releasing a tested candidate

A release publishes the exact tree of the dev tag that passed its test bed,
never `main`'s HEAD (issue 922). So `main` takes merges at any time, even
while a candidate is on the bed. CONTRIBUTING › Releasing has the rest of
the release rules.

## 1. Cut the candidate

On the release branch (for example `rel/1.2.3`), set the version to
`1.2.3-dev.N`, commit, and push a signed, annotated tag on that commit:

```sh
git tag -s -a v1.2.3-dev.N -m "items: <the issues it carries>"
git push origin v1.2.3-dev.N
```

A lightweight tag, or one GitHub doesn't show as verified, can't be
promoted. Pushing the tag starts the release's dry run
(`release-dry-run.yml`).

## 2. Record the bed's verdict

Whoever runs the candidate on a test bed records its verdict as a commit
status on the dev tag's commit. The context is `release/bed`, or the
repository variable `RELEASE_BED_CONTEXT` when it is set. Only `success`
lets the candidate be promoted:

```sh
sha=$(git rev-parse v1.2.3-dev.N^{commit})
gh api --method POST "repos/<owner>/<repo>/statuses/$sha" \
  -f state=success -f context=release/bed \
  -f description="bed PASS for v1.2.3-dev.N"
```

A failed run records `-f state=failure`. A failure is fixed in a new dev
tag, never by setting `success` on the old one. The tester needs write
access to the repository (a token with the `repo:status` scope is enough).

## 3. Promote it

On the release branch, make the release's version commit right on top of
the dev tag. It changes only Den's version (`package.json`,
`package-lock.json`, `examples/distribution/package.json`) and the
changelog entry (`CHANGELOG.md`). Push the branch, then start the release
with that commit:

```sh
gh workflow run release.yml -f promote=<the version commit's sha>
```

`scripts/release-promote.sh` refuses it unless:

- its version is a release (no `-dev.N`), and npm doesn't have it yet;
- its parent carries the signed dev tag `v<version>-dev.N`;
- that commit's `release/bed` status is `success`;
- it changes nothing but the version files;
- `v<version>` tags no other commit.

Then the release builds that commit: the gates, the tarball, SHA256SUMS,
the tag `v<version>`, `npm publish`, and a GitHub release. The tarball
carries `release.json` (the version, the dev tag, its commit and the
release commit), and SHA256SUMS ends with a line naming the dev tag and
its commit.

## 4. Merge it into main

Merge the release branch into `main` afterwards, like any other pull
request. A push to `main` publishes nothing.
