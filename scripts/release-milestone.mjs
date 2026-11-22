#!/usr/bin/env node
/**
 * The release's milestone check (CONTRIBUTING › Releasing, issue 743): no
 * release while its own milestone holds open items with no fix on main.
 *
 *   node scripts/release-milestone.mjs <version> <sha> [--check]
 *     Needs GITHUB_REPOSITORY (owner/name) and a token gh can use (GH_TOKEN).
 *     --check: say what would move, move nothing.
 *     Exit 0: every open issue in the milestone "Den <version>" is accounted
 *     for (or there is no such milestone: a warning). 1: one or more isn't
 *     (each named, with its title and why), or GitHub couldn't answer.
 *     2: bad arguments.
 *
 * An open issue is accounted for when either:
 *   - its fix is on main: a merged pull request that names it (GitHub's
 *     cross-reference), whose merge commit is in <sha>'s history; or a commit
 *     in <sha>'s history whose message names it ("#N" or "issue N"). Only its
 *     live proof is still owed, so it stays open: nothing here closes issues.
 *   - it carries the label `moved` (DEN_MOVED_LABEL): it moves to the next
 *     open milestone "Den <x.y.z>" after <version> (made as "Den <next
 *     patch>" when there is none), and the label comes off, so the next
 *     release asks about it again.
 * Nothing moves unless every open issue is accounted for.
 *
 * The release's tag job runs it before the tag (it needs the whole history).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MOVED_LABEL = process.env.DEN_MOVED_LABEL || "moved";

/** The check failed: message is the ::error:: text, failures the issues behind it. */
export class MilestoneError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.failures = failures;
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v) => {
  const m = VERSION.exec(v);
  return m ? m.slice(1).map(Number) : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const milestoneTitle = (version) => `Den ${version}`;

/** git in <cwd>: is <a> in <head>'s history, and every commit message there. */
export function realGit(cwd = process.cwd()) {
  return {
    isAncestor: (a, head) =>
      spawnSync("git", ["merge-base", "--is-ancestor", a, head], { cwd })
        .status === 0,
    messages: (head) =>
      execFileSync("git", ["log", "--format=%B%x00", head], {
        cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
  };
}

/** Does this text name issue <n>: "#n" or "issue n", not as part of a longer number. */
export function names(text, n) {
  return new RegExp(`(?:#|\\bissues?[ -])${n}(?!\\d)`, "i").test(text);
}

/**
 * The check. deps: version, sha, move (false: --check), github (the calls
 * below), git (realGit), note (a line of output).
 * Returns { moved: [{ number, to }] }; throws MilestoneError.
 */
export function checkMilestone({
  version,
  sha,
  move = true,
  github,
  git,
  note,
}) {
  const own = parse(version);
  if (!own)
    throw new MilestoneError(
      `::error::${version} isn't a release version (x.y.z)`,
    );
  const title = milestoneTitle(version);
  const all = github.milestones();
  const milestone = all.find((m) => m.title === title);
  if (!milestone) {
    note(`::warning::no milestone "${title}": nothing to check`);
    return { moved: [] };
  }
  const issues = github.openIssues(milestone.number);
  let log = null;
  const failures = [];
  const toMove = [];
  for (const issue of issues) {
    if (issue.labels.includes(MOVED_LABEL)) {
      toMove.push(issue);
      continue;
    }
    const pr = issue.prs.find(
      (p) => p.merged && p.mergeCommit && git.isAncestor(p.mergeCommit, sha),
    );
    if (pr) {
      note(
        `#${issue.number} ${issue.title}: fix on main (pull request #${pr.number}); its live proof is owed`,
      );
      continue;
    }
    log ??= git.messages(sha);
    if (log.split("\0").some((m) => names(m, issue.number))) {
      note(
        `#${issue.number} ${issue.title}: fix on main (a commit names it); its live proof is owed`,
      );
      continue;
    }
    failures.push({
      number: issue.number,
      title: issue.title,
      why:
        "no fix on main: no merged pull request or commit on main names it, and it isn't labeled " +
        MOVED_LABEL,
    });
  }
  if (failures.length) {
    const list = failures
      .map((f) => `  #${f.number} ${f.title}: ${f.why}`)
      .join("\n");
    throw new MilestoneError(
      `::error::${failures.length} open issue(s) in the milestone "${title}" aren't accounted for, so ${version} ` +
        `doesn't release:\n${list}\nMerge each fix into main, or label the issue ${MOVED_LABEL} to move it to the ` +
        `next milestone.`,
      failures,
    );
  }
  if (!toMove.length) {
    note(
      `every open issue in "${title}" has its fix on main (${issues.length})`,
    );
    return { moved: [] };
  }
  const next = all
    .filter((m) => m.open && m.title.startsWith("Den "))
    .map((m) => ({ ...m, v: parse(m.title.slice(4)) }))
    .filter((m) => m.v && cmp(m.v, own) > 0)
    .sort((a, b) => cmp(a.v, b.v))[0];
  const nextTitle = next
    ? next.title
    : milestoneTitle(`${own[0]}.${own[1]}.${own[2] + 1}`);
  const moved = toMove.map((i) => ({ number: i.number, to: nextTitle }));
  if (!move) {
    for (const i of toMove)
      note(
        `#${i.number} ${i.title}: labeled ${MOVED_LABEL}, would move to "${nextTitle}"`,
      );
    return { moved };
  }
  const nextNumber = next ? next.number : github.createMilestone(nextTitle);
  for (const i of toMove) {
    github.setMilestone(i.number, nextNumber);
    github.removeLabel(i.number, MOVED_LABEL);
    note(
      `#${i.number} ${i.title}: labeled ${MOVED_LABEL}, moved to "${nextTitle}"`,
    );
  }
  return { moved };
}

/** GitHub through gh, for <owner/name>. */
export function realGithub(repository) {
  const [owner, name] = repository.split("/");
  const gh = (...args) => {
    const r = spawnSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0)
      throw new MilestoneError(
        `::error::gh ${args.slice(0, 3).join(" ")} failed: ${(r.stderr ?? "").trim()}`,
      );
    return r.stdout;
  };
  const graphql = (query, vars) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars))
      args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    return JSON.parse(gh(...args)).data.repository;
  };
  const pr = (p) =>
    p && p.number
      ? { number: p.number, merged: p.merged, mergeCommit: p.mergeCommit?.oid }
      : null;
  return {
    milestones() {
      const out = [];
      let after = "";
      for (;;) {
        const q = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
          milestones(first:100,after:$after,query:"Den "){nodes{number title state}pageInfo{hasNextPage endCursor}}}}`;
        const m = graphql(
          q,
          after ? { owner, name, after } : { owner, name },
        ).milestones;
        out.push(
          ...m.nodes.map((n) => ({
            number: n.number,
            title: n.title,
            open: n.state === "OPEN",
          })),
        );
        if (!m.pageInfo.hasNextPage) return out;
        after = m.pageInfo.endCursor;
      }
    },
    openIssues(number) {
      const out = [];
      let after = "";
      for (;;) {
        const q = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
          milestone(number:$number){issues(first:50,after:$after,states:OPEN){nodes{number title
            labels(first:50){nodes{name}}
            timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){nodes{
              ... on CrossReferencedEvent{source{... on PullRequest{number merged mergeCommit{oid}}}}
              ... on ConnectedEvent{subject{... on PullRequest{number merged mergeCommit{oid}}}}}}}
          pageInfo{hasNextPage endCursor}}}}}`;
        const vars = { owner, name, number };
        if (after) vars.after = after;
        const page = graphql(q, vars).milestone.issues;
        for (const n of page.nodes) {
          out.push({
            number: n.number,
            title: n.title,
            labels: n.labels.nodes.map((l) => l.name),
            prs: n.timelineItems.nodes
              .map((t) => pr(t.source ?? t.subject))
              .filter(Boolean),
          });
        }
        if (!page.pageInfo.hasNextPage) return out;
        after = page.pageInfo.endCursor;
      }
    },
    createMilestone: (title) =>
      JSON.parse(
        gh(
          "api",
          "-X",
          "POST",
          `repos/${repository}/milestones`,
          "-f",
          `title=${title}`,
        ),
      ).number,
    setMilestone: (issue, number) =>
      gh(
        "api",
        "-X",
        "PATCH",
        `repos/${repository}/issues/${issue}`,
        "-F",
        `milestone=${number}`,
      ),
    removeLabel: (issue, label) =>
      gh(
        "api",
        "-X",
        "DELETE",
        `repos/${repository}/issues/${issue}/labels/${encodeURIComponent(label)}`,
      ),
  };
}

function main(argv) {
  const args = argv.filter((a) => a !== "--check");
  const [version, sha] = args;
  const usage =
    "::error::usage: release-milestone.mjs <version> <sha> [--check]";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (
    args.length !== 2 ||
    !parse(version ?? "") ||
    !sha ||
    !/^[^/\s]+\/[^/\s]+$/.test(repository)
  ) {
    console.log(usage + " (GITHUB_REPOSITORY=owner/name)");
    return 2;
  }
  if (
    spawnSync("git", ["rev-parse", "-q", "--verify", `${sha}^{commit}`])
      .status !== 0
  ) {
    console.log(`::error::${sha} isn't a commit here`);
    return 2;
  }
  try {
    checkMilestone({
      version,
      sha,
      move: !argv.includes("--check"),
      github: realGithub(repository),
      git: realGit(),
      note: (s) => console.log(s),
    });
    return 0;
  } catch (e) {
    if (!(e instanceof MilestoneError)) throw e;
    console.log(e.message);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
