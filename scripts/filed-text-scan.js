/**
 * Issue 1127: text filed on GitHub is checked too, not only commits and
 * files. Run daily and on demand by .github/workflows/filed-text-scan.yml.
 * It reads the issues, pull requests and comments created or edited since
 * the last successful run, checks each title and body with the org-name
 * matcher (src/shared/org-names.js), and files one finding per item that
 * holds a listed name: a neutral title, a link to the item, the field, line
 * and pattern number, never the matched text. It never edits the item.
 *
 * The list comes from DEN_ORG_NAMES (a secret) or DEN_ORG_NAMES_FILE, never
 * the repo. With neither, it fails: a missing secret never passes quietly.
 *
 * A finding names the item, so it never goes to the scanned repo (a public
 * one would point readers at the leak): it goes to a private repo,
 * FILED_TEXT_FINDINGS_REPO, filed with a token for that repo alone
 * (FILED_TEXT_FINDINGS_TOKEN: the workflow mints it from a GitHub App).
 * With no destination or no token the run fails, saying only how many
 * items and their numbers. The log never holds item text:
 * a workflow's log is public too.
 *
 *   node scripts/filed-text-scan.mjs --repo owner/name [--since <ISO time>] [--dry-run]
 *
 * --since defaults to the start of this workflow's last successful run
 * (else 25 hours ago). --dry-run files nothing. It reads with `gh`
 * (GH_TOKEN) and files with FILED_TEXT_FINDINGS_TOKEN.
 */
import { execFileSync } from "node:child_process";

import { orgHitsByLine, orgPatterns } from "../src/shared/org-names.js";

/**
 * The label a finding carries in the findings repo (made there once), so
 * the next run doesn't file it again.
 */
export const FINDING_LABEL = "filed-text-finding";
const WORKFLOW = "filed-text-scan.yml";

/**
 * GitHub's issues (pull requests among them: they carry `pull_request`) and
 * issue or pull request comments, as items: { url, kind, title?, body,
 * updatedAt }.
 */
export function itemsOf(issues, comments) {
  return [
    ...issues.map((i) => ({
      url: i.html_url,
      kind: i.pull_request ? "pull request" : "issue",
      title: i.title ?? "",
      body: i.body ?? "",
      updatedAt: i.updated_at,
    })),
    ...comments.map((c) => ({
      url: c.html_url,
      kind: "comment",
      body: c.body ?? "",
      updatedAt: c.updated_at,
    })),
  ];
}

/**
 * One finding per item created or edited at or after `since` that holds a
 * listed name: { url, kind, hits: [{ field, line, index }] }.
 */
export function findingsFor(items, patterns, since, repo) {
  const from = Date.parse(since);
  const out = [];
  for (const item of items) {
    if (!(Date.parse(item.updatedAt) >= from)) continue;
    const texts = [
      ...(item.title !== undefined
        ? [{ field: "title", text: item.title }]
        : []),
      { field: item.kind === "comment" ? "comment" : "body", text: item.body },
    ];
    const hits = orgHitsByLine(texts, patterns, repo);
    if (hits.length) out.push({ url: item.url, kind: item.kind, hits });
  }
  return out;
}

/** A finding's issue: a neutral title, the link, where; never the text. */
export function findingText(f) {
  const where = f.hits
    .map((h) => `- ${h.field} line ${h.line}: listed pattern #${h.index}`)
    .join("\n");
  return {
    title: `Words check: a filed ${f.kind} needs an edit`,
    body: [
      `The scheduled words check found a listed name in this ${f.kind}:`,
      "",
      f.url,
      "",
      where,
      "",
      "Edit it to take the name out, then close this issue. The matched text is not shown here, and the item was not changed.",
      "",
      "(Den's filed-text scan, issue 1127.)",
    ].join("\n"),
  };
}

/** An item's number as a log may say it: "issue 12", "comment 345". */
export function itemRef(url) {
  const c = /#(?:issuecomment|discussion_r)-?(\d+)$/.exec(url);
  if (c) return `comment ${c[1]}`;
  const n = /\/(issues|pull)\/(\d+)/.exec(url);
  return n
    ? `${n[1] === "pull" ? "pull request" : "issue"} ${n[2]}`
    : "an item";
}

/** The real gh, with an optional token of its own (the findings repo's). */
function realGh(args, { input, token } = {}) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 1 << 28,
    ...(input !== undefined ? { input } : {}),
    ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
  });
}

/**
 * One scan. `gh(args, { input?, token? })` answers like the CLI; `log`
 * takes each line of output. Returns the exit code.
 */
export function runScan({
  repo,
  findingsRepo,
  findingsToken,
  since,
  patterns,
  dryRun = false,
  gh = realGh,
  log = (l) => console.log(l),
}) {
  const list = (p, token) =>
    JSON.parse(gh(["api", "--paginate", "--slurp", p], { token })).flat();
  const q = `since=${encodeURIComponent(since)}&per_page=100`;
  const issues = list(`repos/${repo}/issues?state=all&${q}`);
  const comments = [
    ...list(`repos/${repo}/issues/comments?${q}`),
    ...list(`repos/${repo}/pulls/comments?${q}`),
  ];
  const findings = findingsFor(
    itemsOf(issues, comments),
    patterns,
    since,
    repo,
  );
  const refs = findings.map((f) => itemRef(f.url));
  log(
    `filed-text scan: ${issues.length + comments.length} item(s) since ${since}, ${findings.length} with a listed name${refs.length ? `: ${refs.join(", ")}` : ""}`,
  );
  if (!findings.length) return 0;
  if (!findingsRepo || findingsRepo === repo || !findingsToken) {
    log(
      "filed-text scan: no private findings repo (FILED_TEXT_FINDINGS_REPO and FILED_TEXT_FINDINGS_TOKEN); nothing was filed",
    );
    return 1;
  }
  if (dryRun) return 0;
  // One open finding per item: the next run doesn't file it again.
  const open = list(
    `repos/${findingsRepo}/issues?state=open&labels=${FINDING_LABEL}&per_page=100`,
    findingsToken,
  );
  let filed = 0;
  for (const f of findings) {
    if (open.some((o) => (o.body ?? "").includes(f.url))) continue;
    const t = findingText(f);
    gh(
      [
        "issue",
        "create",
        "-R",
        findingsRepo,
        "--title",
        t.title,
        "--label",
        FINDING_LABEL,
        "--body-file",
        "-",
      ],
      { input: t.body, token: findingsToken },
    );
    filed++;
  }
  log(`filed-text scan: ${filed} new finding(s) filed in the findings repo`);
  return 0;
}

function lastRunStart(repo) {
  try {
    const runs = JSON.parse(
      realGh([
        "api",
        `repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=1`,
      ]),
    ).workflow_runs;
    return runs?.[0]?.run_started_at ?? null;
  } catch {
    return null;
  }
}

/** The command line (scripts/filed-text-scan.mjs runs it). */
export function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = arg("--repo");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(
      "usage: filed-text-scan.mjs --repo owner/name [--since <ISO time>] [--dry-run]",
    );
    return 2;
  }
  const patterns = orgPatterns();
  if (!patterns.length) {
    console.error(
      "filed-text scan: no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)",
    );
    return 2;
  }
  return runScan({
    repo,
    findingsRepo: (process.env.FILED_TEXT_FINDINGS_REPO ?? "").trim(),
    findingsToken: process.env.FILED_TEXT_FINDINGS_TOKEN ?? "",
    since:
      arg("--since") ??
      lastRunStart(repo) ??
      new Date(Date.now() - 25 * 3_600_000).toISOString(),
    patterns,
    dryRun: argv.includes("--dry-run"),
  });
}
