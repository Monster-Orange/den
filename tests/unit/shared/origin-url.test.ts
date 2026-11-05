/**
 * readOriginUrl reads a checkout's origin from its git config file, and must
 * agree with `git config --get remote.origin.url`: in the checkout, in a
 * subdirectory of it, in a linked worktree, and (null) outside any repo.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  originUrlFromConfig,
  readOriginUrl,
} from "../../../src/shared/git/origin-url.js";

let tmp = "";
const git = (cwd: string, args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "";
};
const gitOrigin = (dir: string): string | null =>
  git(dir, ["config", "--get", "remote.origin.url"]) || null;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-origin-")));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "sub", "deeper"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "upstream", "https://example.com/acme/up.git"]);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/shop.git"]);
  git(repo, [
    "-c",
    "user.email=a@example.com",
    "-c",
    "user.name=a",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  git(repo, ["worktree", "add", "-q", path.join(tmp, "wt"), "-b", "wt"]);
  fs.mkdirSync(path.join(tmp, "plain"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readOriginUrl", () => {
  it.each(["repo", "repo/sub/deeper", "wt", "plain"])(
    "agrees with git in %s",
    (rel) => {
      const dir = path.join(tmp, rel);
      expect(readOriginUrl(dir)).toBe(gitOrigin(dir));
    },
  );

  it("is the origin, not another remote", () => {
    expect(readOriginUrl(path.join(tmp, "repo"))).toBe(
      "git@github.com:acme/shop.git",
    );
  });
});

describe("originUrlFromConfig", () => {
  it("reads quoted values, ignores comments and other sections", () => {
    expect(
      originUrlFromConfig(
        [
          "[core]",
          "  url = nope",
          '[remote "fork"]',
          "  url = https://example.com/fork.git",
          "# a comment",
          '[remote "origin"]',
          '  url = "https://example.com/acme/x.git" ; trailing',
        ].join("\n"),
      ),
    ).toBe("https://example.com/acme/x.git");
    expect(originUrlFromConfig("[core]\n  bare = false\n")).toBeNull();
  });
});
