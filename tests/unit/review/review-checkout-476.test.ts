/**
 * Issue 476: a review leg runs in a fresh read-only checkout at the PR's
 * head. It holds no push credential and no remote: every push fails, its
 * files can't be written, and the leg's environment carries no GitHub
 * token, askpass or SSH agent.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  legEnv,
  reviewCheckout,
  removeCheckout,
} from "../../../src/shared/review/mesh/checkout.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+w", d]);
    } catch {
      /* gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-review-co-"));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ],
    { cwd, stdio: "pipe", encoding: "utf-8" },
  ).trim();

function repoWithTwoCommits() {
  const repo = path.join(temp(), "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  const first = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "a.ts"), "two\n");
  git(repo, "commit", "-qam", "two");
  return { repo, first };
}

describe("the review checkout", () => {
  it("is at the asked head, with no remote, and every push fails", () => {
    const { repo, first } = repoWithTwoCommits();
    const bare = path.join(temp(), "bare.git");
    git(temp(), "init", "-q", "--bare", bare);
    const dir = path.join(temp(), "leg");
    reviewCheckout(repo, first, dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(first);
    expect(fs.readFileSync(path.join(dir, "a.ts"), "utf-8")).toBe("one\n");
    expect(git(dir, "remote")).toBe("");
    expect(() => git(dir, "push", "-q", bare, "HEAD:refs/heads/x")).toThrow();
    expect(() =>
      git(dir, "push", "-q", "https://github.com/octo/app", "HEAD"),
    ).toThrow();
    expect(git(bare, "for-each-ref")).toBe("");
  });

  it("its files and its git folder can't be written", () => {
    const { repo, first } = repoWithTwoCommits();
    const dir = path.join(temp(), "leg");
    reviewCheckout(repo, first, dir);
    expect(() =>
      fs.writeFileSync(path.join(dir, "a.ts"), "changed\n"),
    ).toThrow();
    expect(() => fs.writeFileSync(path.join(dir, "new.ts"), "x\n")).toThrow();
    expect(() =>
      git(dir, "commit", "-q", "--allow-empty", "-m", "x"),
    ).toThrow();
  });

  it("a head that isn't a full commit id is refused", () => {
    const { repo } = repoWithTwoCommits();
    for (const bad of ["main", "--upload-pack=x", "a1b2c3"])
      expect(() =>
        reviewCheckout(repo, bad, path.join(temp(), "leg")),
      ).toThrow();
  });

  it("is removed whole, read-only files and all", () => {
    const { repo, first } = repoWithTwoCommits();
    const dir = path.join(temp(), "leg");
    reviewCheckout(repo, first, dir);
    removeCheckout(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("the leg's environment", () => {
  it("drops tokens, keys, askpass helpers and the SSH agent; keeps the runtime's own subscription sign-in", () => {
    const env = legEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      GH_ENTERPRISE_TOKEN: "t3",
      GITHUB_ENTERPRISE_TOKEN: "t4",
      GIT_ASKPASS: "/x",
      SSH_ASKPASS: "/y",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OP_SERVICE_ACCOUNT_TOKEN: "t5",
      NPM_TOKEN: "t6",
      ANTHROPIC_API_KEY: "metered",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
