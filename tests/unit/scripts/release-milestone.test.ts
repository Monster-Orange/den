/**
 * The release's milestone check (scripts/release-milestone.mjs, issue 743).
 *
 * A release shipped while issues in its own milestone were still open, and
 * they sat unnoticed in the milestone of a version already out. Now, before
 * the release tags and publishes, every open issue in the milestone
 * "Den <version>" is accounted for: its fix is on main (a merged pull
 * request whose merge commit is in the release's history, or a commit in
 * that history naming the issue), or it carries the label `moved` and goes
 * to the next milestone. Any other open issue stops the release, listed
 * with its number, its title and why.
 *
 * GitHub is a stub (a "world"); git is a real temp repo, no signing, no
 * global config. The script is plain ESM, so each case runs in a child Node.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
let repo: string;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const commit = (msg: string) => {
  git("commit", "-q", "--allow-empty", "-m", msg);
  return git("rev-parse", "HEAD");
};

interface Pr {
  number: number;
  merged: boolean;
  mergeCommit?: string;
}
interface Issue {
  number: number;
  title: string;
  labels?: string[];
  prs?: Pr[];
}
interface World {
  /** milestone title → its number and its open issues; a missing title has no milestone */
  milestones: Record<
    string,
    { number: number; open: boolean; issues: Issue[] }
  >;
}
interface Result {
  ok: boolean;
  error?: string;
  failures?: { number: number; title: string; why: string }[];
  moved?: { number: number; to: string }[];
  calls: unknown[][];
  notes: string[];
}

/** checkMilestone with a stubbed GitHub and real git in the temp repo. */
function check(
  world: World,
  version: string,
  sha: string,
  opts: { move?: boolean } = {},
): Result {
  const js = `
    const { checkMilestone, realGit, MilestoneError } = await import(${JSON.stringify(
      path.join(ROOT, "scripts/release-milestone.mjs"),
    )});
    const w = ${JSON.stringify(world)};
    const calls = [], notes = [];
    let nextNumber = 900;
    const github = {
      milestones: () => Object.entries(w.milestones).map(([title, m]) => ({ title, number: m.number, open: m.open })),
      openIssues: (number) => {
        calls.push(["openIssues", number]);
        const m = Object.values(w.milestones).find((x) => x.number === number);
        return m.issues.map((i) => ({ labels: [], prs: [], ...i }));
      },
      createMilestone: (title) => { calls.push(["createMilestone", title]); return nextNumber++; },
      setMilestone: (issue, number) => calls.push(["setMilestone", issue, number]),
      removeLabel: (issue, label) => calls.push(["removeLabel", issue, label]),
    };
    let out;
    try {
      const r = checkMilestone({
        version: ${JSON.stringify(version)},
        sha: ${JSON.stringify(sha)},
        move: ${JSON.stringify(opts.move ?? true)},
        github,
        git: realGit(${JSON.stringify(repo)}),
        note: (s) => notes.push(s),
      });
      out = { ok: true, ...r, calls, notes };
    } catch (e) {
      if (!(e instanceof MilestoneError)) throw e;
      out = { ok: false, error: e.message, failures: e.failures, calls, notes };
    }
    console.log(JSON.stringify(out));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
    }),
  ) as Result;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-milestone-"));
  git("init", "-q", "-b", "main");
  commit("base");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const OPEN = { number: 7, title: "Sign-in: the code field forgets its value" };

describe("release-milestone.mjs: open items in the version's milestone", () => {
  it("an open issue with no fix on main stops the release, listing its number, title and why", () => {
    const rel = commit("Den 1.2.0");
    const r = check(
      {
        milestones: { "Den 1.2.0": { number: 3, open: true, issues: [OPEN] } },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      {
        number: 7,
        title: OPEN.title,
        why: expect.stringMatching(/no fix on main/),
      },
    ]);
    expect(r.error).toMatch(/^::error::/);
    expect(r.error).toContain("#7");
    expect(r.error).toContain(OPEN.title);
    expect(r.error).toContain("Den 1.2.0");
    expect(r.error).toMatch(/moved/);
  });

  it("the same issue with a merged pull request whose merge commit is on main: passes", () => {
    const merge = commit("Merge branch 'lane/x' into rel/1.2.0");
    const rel = commit("Den 1.2.0");
    const issue = {
      ...OPEN,
      prs: [{ number: 40, merged: true, mergeCommit: merge }],
    };
    const r = check(
      {
        milestones: { "Den 1.2.0": { number: 3, open: true, issues: [issue] } },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(true);
    expect(r.notes.join("\n")).toMatch(/#7 .*fix on main.*#40/);
  });

  it("a commit on main naming the issue (#N or issue N) counts as its fix; another number doesn't", () => {
    commit("Sign-in: keep the code (Refs #7)");
    const rel = commit("Den 1.2.0");
    const world = (n: number) => ({
      milestones: {
        "Den 1.2.0": {
          number: 3,
          open: true,
          issues: [{ ...OPEN, number: n }],
        },
      },
    });
    expect(check(world(7), "1.2.0", rel).ok).toBe(true);
    expect(check(world(70), "1.2.0", rel).ok).toBe(false);
    commit("Tests: the code field (issue 70)");
    expect(check(world(70), "1.2.0", git("rev-parse", "HEAD")).ok).toBe(true);
  });

  it("a merged pull request that isn't in the release's history, or an unmerged one, doesn't count", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    const side = commit("side work");
    git("checkout", "-q", "main");
    git("reset", "-q", "--hard", base);
    const rel = commit("Den 1.2.0");
    const issue = {
      ...OPEN,
      prs: [
        { number: 41, merged: true, mergeCommit: side },
        { number: 42, merged: false },
      ],
    };
    const r = check(
      {
        milestones: { "Den 1.2.0": { number: 3, open: true, issues: [issue] } },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(false);
    expect(r.failures?.[0].number).toBe(7);
  });

  it("an issue labeled moved goes to the next open milestone and loses the label", () => {
    const rel = commit("Den 1.2.0");
    const r = check(
      {
        milestones: {
          "Den 1.2.0": {
            number: 3,
            open: true,
            issues: [{ ...OPEN, labels: ["moved"] }],
          },
          "Den 1.3.0": { number: 5, open: true, issues: [] },
          "Den 1.2.1": { number: 4, open: true, issues: [] },
          "Den 1.1.9": { number: 2, open: true, issues: [] },
        },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(true);
    expect(r.moved).toEqual([{ number: 7, to: "Den 1.2.1" }]);
    expect(r.calls).toContainEqual(["setMilestone", 7, 4]);
    expect(r.calls).toContainEqual(["removeLabel", 7, "moved"]);
  });

  it("no next milestone yet: makes Den <next patch> and moves the issue there", () => {
    const rel = commit("Den 1.2.0");
    const r = check(
      {
        milestones: {
          "Den 1.2.0": {
            number: 3,
            open: true,
            issues: [{ ...OPEN, labels: ["moved"] }],
          },
        },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(true);
    expect(r.calls).toContainEqual(["createMilestone", "Den 1.2.1"]);
    expect(r.calls).toContainEqual(["setMilestone", 7, 900]);
  });

  it("one unaccounted issue stops the release before anything moves", () => {
    const rel = commit("Den 1.2.0");
    const r = check(
      {
        milestones: {
          "Den 1.2.0": {
            number: 3,
            open: true,
            issues: [
              { number: 8, title: "moving on", labels: ["moved"] },
              OPEN,
            ],
          },
        },
      },
      "1.2.0",
      rel,
    );
    expect(r.ok).toBe(false);
    expect(r.failures?.map((f) => f.number)).toEqual([7]);
    expect(r.calls.filter((c) => c[0] !== "openIssues")).toEqual([]);
  });

  it("check only (move: false) reports the moves without making them", () => {
    const rel = commit("Den 1.2.0");
    const r = check(
      {
        milestones: {
          "Den 1.2.0": {
            number: 3,
            open: true,
            issues: [{ ...OPEN, labels: ["moved"] }],
          },
        },
      },
      "1.2.0",
      rel,
      { move: false },
    );
    expect(r.ok).toBe(true);
    expect(r.moved).toEqual([{ number: 7, to: "Den 1.2.1" }]);
    expect(r.calls.filter((c) => c[0] !== "openIssues")).toEqual([]);
  });

  it("no milestone for the version: passes with a warning", () => {
    const rel = commit("Den 1.2.0");
    const r = check({ milestones: {} }, "1.2.0", rel);
    expect(r.ok).toBe(true);
    expect(r.notes.join("\n")).toMatch(/::warning::no milestone "Den 1\.2\.0"/);
  });

  it("the CLI refuses bad arguments", () => {
    const run = (...a: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(ROOT, "scripts/release-milestone.mjs"), ...a],
        {
          cwd: repo,
          env: { ...env, GITHUB_REPOSITORY: "o/r" },
          encoding: "utf8",
        },
      );
    expect(run().status).toBe(2);
    expect(run("1.2.0;rm", "HEAD").status).toBe(2);
    expect(run("1.2.0").status).toBe(2);
  });
});

describe("release.yml runs the milestone check", () => {
  it("in the tag job, before the tag, with the right to move issues", () => {
    const wf = yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    const tag = wf.jobs.tag;
    expect(tag.permissions.issues).toBe("write");
    const steps: {
      name?: string;
      run?: string;
      env?: Record<string, string>;
    }[] = tag.steps;
    const check = steps.findIndex((s) =>
      /scripts\/release-milestone\.mjs/.test(s.run ?? ""),
    );
    const tagStep = steps.findIndex((s) => /git tag /.test(s.run ?? ""));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(tagStep);
    expect(steps[check].run).toContain("needs.check.outputs.version");
    expect(steps[check].env?.GH_TOKEN).toMatch(/github\.token/);
  });
});
