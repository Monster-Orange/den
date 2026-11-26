# Guardrail lint

MO's shared lint rules. Each one turns an anti-pattern an agent was caught making into a check that every repo runs on every change. The plan is "Lint as guardrail" in Hub (Den project).

## Run

```
node lint/mo-gates.mjs --base origin/main   # only the lines this branch adds (what a pull request gets)
node lint/mo-gates.mjs --all                # every tracked file: a repo's count
node lint/mo-gates.mjs --pr-text            # PR_TITLE and PR_BODY
node lint/selftest.mjs                      # every rule against its fixtures
```

Exit 0 is clean, 1 is a hit and 2 is an error (a missing base is never a pass). In a repo on the shared workflow, the pull request job runs it through `.github/actions/guardrail-lint`.

## Adopt it in a repo

A private Monster-Orange repo calls the reusable workflow. Add this to a workflow that runs on `pull_request` (and `merge_group`, if the repo has a merge queue):

```yaml
jobs:
  guardrail-lint:
    uses: Monster-Orange/mo-commons/.github/workflows/guardrail-lint.yml@main
    # with:
    #   pr-text: false   # when the repo already judges the PR's title and body
```

Trigger it on `pull_request`, never `pull_request_target`. A repo with a merge queue also triggers on `merge_group`, or the required check never reports in the queue.

It judges only the lines the change adds since its merge base, so hits already on the base never block. Make `guardrail-lint / guardrail-lint` a required check, or have the repo's own required check need it.

**In a public repo.** GitHub lets only private repos call a private repo's workflow. A public repo keeps a copy of `mo-gates.mjs`, `rules.json` and `rules/` (unchanged), and a `SOURCE` file holding the commit here it was copied from. It runs `node <copy>/mo-gates.mjs --base <base sha>` in its pull request job, from the base's copy, so a change can't edit the rules that judge it. `lint.yml` here checks Den's copy on its integration branch (next/queue) each night and on every push to main (`node lint/copy-check.mjs <copy>`): it fails when a copied file differs from that commit, or when the lint has changed since. Then copy the files again and update `SOURCE`.

## Rules

`rules.json` holds them. A `line` rule is a pattern judged line by line, a `module` rule is a file in `rules/` whose `check(src, path)` returns line ranges, and a `pr-text` rule judges the PR's title and body.

A moved file is paired with its old path (`-M30% -C30%`), also when a re-export stays at the old path (git reports it as a copy from a changed file). Every rule then judges only the lines the move changed, never the ones it carried, and a ratchet counts the moved file against its old path's count. Each base file counts once: when a copy takes it, the old path's own row starts from 0. So a pure move counts zero, and a copy can't pay twice. A file moved in from a path the rule doesn't judge counts from 0.

A `ratchet` rule is a file in `rules/` whose `count(src, path)` lists the lines it counts. With `--base`, the runner sums them over every file the change touched, at the base and at HEAD, and fails when the sum rises. The count is per change, so a block moved from one touched file to another passes, and so does a rename. A new file counts from 0 (so a block moved into a new file still passes), a deleted file's count comes off, and a file with a side that can't be read (binary, over 2 MB) is left out. The base side is the newer of the merge base and `since`. A ratchet marked `opt_in` runs only in a repo whose `.guardrail-lint.json` lists it in `on`. `--all` never judges a ratchet.

| Rule | Catches |
|---|---|
| mo/expect-poll-in-jest | `expect.poll` in a jest file: jest has none |
| mo/no-networkidle | Playwright's `networkidle` wait |
| mo/fixed-date-real-clock | a test case that plants a fixed date and reads the real clock |
| mo/no-fixed-sleep | `waitForTimeout`, or a fixed sleep of 100 ms or more, in a browser test or live check (the scan is Den's brittle-ratchet's, in `rules/brittle-scan.mjs`) |
| mo/no-positional-locator | `.nth()`, `.first()`, `.last()`, `:nth-child` and friends, or a list read by index, in a browser test or live check |
| mo/no-class-selector | a styling `.class` in a selector string (locator, `$`, waitForSelector, querySelector…) |
| mo/wall-clock-bound | a test that bounds real elapsed time under 1 s (`expect(Date.now() - t0).toBeLessThan(100)`, or through a name) |
| mo/no-history-comment | a code comment that records history: an issue or PR number, a person with a date, or "was X before" / "no longer" (history goes in the commit and the PR) |
| mo/comment-count | (ratchet, opt-in) the count of comment lines across the files a change touched, new ones included, rises. Shebangs, license headers and tool directives (eslint, `@ts-`, prettier, coverage) don't count; a `mo-lint-ok` line counts, and nothing excuses this rule |
| mo/no-close-keywords | "Fixes #N" and the like in a PR's title or body |

## Where a repo's rules start

A repo's `.guardrail-lint.json`, at its root, may set `since`, the commit where the rules landed there:

```json
{ "since": "<40-hex commit>", "on": ["mo/comment-count"] }
```

`on` turns on the opt-in rules it lists. `exclude` is a list of globs that every rule skips, for code a repo vendors from elsewhere and must keep byte for byte:

```json
{ "exclude": ["skill-packs/pstack/**"] }
```

Name each vendored folder, not a parent of the repo's own files. Each glob must start with a folder named in full: `**`, `*.ts` or `**/vendor/**` is refused. Like `since`, `exclude` is read from the base's tree with `--base`, so a change can't exclude its own files: land the exclude first, in its own reviewed change. `--all` reads it from HEAD.

With `--base`, lines already there at that commit never count, even when the base is older. That covers a queue or release branch judged against main, which would otherwise count every line merged before the rules existed. A hit added after `since` still fails. `since` is read from the base's tree, so a change can't set the line that judges it: put it on the base branch first (for a queue judged against main, on main). A branch whose history doesn't include `since` is judged from its merge base as usual. The file is the repo's own, so a public repo's copy of the lint stays unchanged, and its name carries no org's name.

## Excusing a hit

Write `mo-lint-ok: <reason>` on the line or the line above. For a module rule, put it anywhere in the reported range. A tag with no reason does not count. Excuses are counted each week.

## Adding a rule

1. Add it to `rules.json`, with a message that says what is wrong and what to do instead.
2. Add `fixtures/<rule>/red*` (it must fail) and `green*` (it must pass). The selftest fails a rule that has no red fixture.
3. Run it on the real commit where the anti-pattern was caught, and paste the red output in the pull request. Then paste the green output on the fix.
