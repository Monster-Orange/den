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

Sign it with a key listed in `.github/release-signers` (an SSH
allowed-signers file). A lightweight tag, an unsigned one, or one signed
by another key can't be promoted. To let another key sign candidates, add
its line to that file in a pull request to `main`. Pushing the tag starts the release's dry run
(`release-dry-run.yml`).

The dry run's serial jobs (plan, the checks and the tarball) can run on
your own self-hosted runners, so a candidate doesn't wait behind
pull-request CI. Set the repository variable `DEN_RELEASE_SELF_HOSTED`
to `on` and `DEN_RELEASE_RUNNER_LABELS` to the runners' labels as a JSON
array, such as `["self-hosted","linux"]`. The list must include
`self-hosted`: that's how the fallback tells the runners' jobs apart. There's
no default: with the switch on and no labels, the dry run stops at its first
step and says so, and no job waits for a runner. They're
used only on a dev tag's push. The test shards and every job of the release itself stay
GitHub-hosted. If no runner takes a job within
`DEN_RELEASE_BOX_WAIT_MINUTES` (default 10), the dry run starts again by
itself on GitHub-hosted runners, and says so in its log. The job that
watches for this is `box-watch`. If it fails (it couldn't read the run's
jobs, or it ran past its 120 minutes), the dry run shows as failed even when
the gates passed: read the gates' own jobs before you read a red dry run as
a red candidate.

## 2. Record the bed's verdict

Whoever runs the candidate on a test bed records its verdict as a commit
status on the dev tag's commit. The context is `release/bed`, or the
repository variable `RELEASE_BED_CONTEXT` when it is set. Only the newest
status in that context counts, only `success` lets the candidate be
promoted, and only when it was set by a GitHub login listed in the
repository secret `RELEASE_BED_CREATORS` (comma or space separated).
With no login listed, nothing can be promoted. It is a secret, not a
variable, because a login can be a person's own account and the
workflow's logs are public: GitHub masks a secret in them, and a refusal
never names a login.

```sh
sha=$(git rev-parse v1.2.3-dev.N^{commit})
gh api --method POST "repos/<owner>/<repo>/statuses/$sha" \
  -f state=success -f context=release/bed \
  -f description="bed PASS for v1.2.3-dev.N"
```

A failed run records `-f state=failure`. A failure is fixed in a new dev
tag, never by setting `success` on the old one. The tester's token needs
the right to set commit statuses (`repo:status`, or `statuses: write`),
and the tester's login must be in `RELEASE_BED_CREATORS`.

### What a PASS proves

While the agents share one GitHub login and one signing key, a PASS
proves the bed ran, not who ran it: any agent with that login can sign a
dev tag and set the status. It still catches a candidate with no PASS or
a failed one. The gates that hold today are the signed dev tag, a release
from `main` only, and the tested-tree check (the release's tree is the
dev tag's, and a green CI run tested it with the whole suite, on its first
attempt). A green from a re-run never counts: a red is fixed in a fresh
head, never re-run to green. A login only the bed holds (a
GitHub App, issue 1181) will make a PASS name its tester too.

## 3. Promote it

On the release branch, make the release's version commit right on top of
the dev tag. It changes only the version: Den's `version` in
`package.json`, the root's version in `package-lock.json`, the pin in
`examples/distribution/package.json`, and new lines in `CHANGELOG.md`
(its `## [<version>] - unreleased` heading may get its date). Push the
branch, then start the release from `main` with that commit:

```sh
gh workflow run release.yml -f promote=<the version commit's sha>
```

`scripts/release-promote.sh` refuses it unless:

- the run is on `main` (a run on any other branch stops at once);
- its version is a release (no `-dev.N`), and npm doesn't have it yet;
- its parent carries the dev tag `v<version>-dev.N`, signed by an allowed
  key;
- that commit's newest `release/bed` status is `success`, set by a listed
  tester;
- it changes nothing but the version, as above;
- `v<version>` tags no other commit.

The jobs that publish (Den, and the UI kit) run in the `release`
environment. That environment allows only `main`; required reviewers
on it, when set, are the people who approve each publish. On npm, the package's
trusted publisher must name that `release` environment too, so npm takes
a publish only from it. These are settings outside the repository: set
them before the first release that should prove them.

Then the release builds that commit: the gates, the tarball, SHA256SUMS,
the tag `v<version>`, `npm publish`, and a GitHub release. The tarball
carries `release.json` (the version, the dev tag, its commit and the
release commit), and SHA256SUMS ends with a line naming the dev tag and
its commit.

## 4. Merge it into main

Merge the release branch into `main` afterwards, like any other pull
request. A push to `main` publishes nothing.
