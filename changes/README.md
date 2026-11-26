# Changelog fragments

A pull request that changes `src/`, `packages/` or `bin/` adds one file
here instead of editing `CHANGELOG.md`, which only the version commit
changes. Many pull requests can then be open at once without editing the
same lines.

Name it `changes/<issue>-<slug>.md`: the issue's number, then lowercase
words joined by `-` (for example `changes/1703-changelog-fragments.md`).
Inside, put one or more `### <section>` headings, each with its `- ` lines,
written the way they read in the changelog:

```markdown
### Fixed

- The address card no longer shows a port another program holds.
```

The sections are Security, Added, Changed, Deprecated, Removed, Fixed,
Migrations, Checks, Tests, Docs and Known issues. List what a distribution
must change under Migrations.

A change people never see can say why in the pull request's body instead,
on a line of its own: `no-changelog: <reason>`.

The version commit (`node scripts/release-dry-run.mjs apply <version> <kit
version> <date>`) puts every fragment's lines under that version in
`CHANGELOG.md`, one heading per section in the order above, oldest issue
first, and removes the fragments.
