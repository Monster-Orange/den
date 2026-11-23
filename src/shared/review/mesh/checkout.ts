/**
 * Issue 476 (REVIEW-MESH-SPEC RV-4, RV-8 item 16): a review leg's fresh,
 * read-only checkout at the PR's head, and the environment it runs with.
 *
 * The checkout is a local clone with its remote removed, every push URL
 * rewritten to one git can't use (an empty pushInsteadOf matches them all),
 * no credential helper and no hooks. Then every file in it, its .git
 * folder too, is made read-only. Den fetched the head into `repoPath`
 * first; the clone never talks to GitHub.
 *
 * The leg's session gets no push credential from its environment either:
 * every agent session starts from Den's allowlist (sessions/env.ts), with
 * no GitHub token, askpass helper or SSH agent.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";

const SHA_RE = /^[0-9a-f]{40}$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Clones `repoPath` at `sha` into `dir` (which must not exist), read-only. */
export function reviewCheckout(
  repoPath: string,
  sha: string,
  dir: string,
): void {
  if (!SHA_RE.test(sha)) throw new Error("the head must be a full commit id");
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  git(repoPath, [
    "clone",
    "-q",
    "--no-checkout",
    "--no-hardlinks",
    "--",
    repoPath,
    dir,
  ]);
  try {
    git(dir, [
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "-q",
      "--detach",
      sha,
    ]);
    git(dir, ["remote", "remove", "origin"]);
    git(dir, ["config", "url.no-push://den-review-leg/.pushInsteadOf", ""]);
    git(dir, ["config", "credential.helper", ""]);
    git(dir, ["config", "core.hooksPath", "/dev/null"]);
    execFileSync("chmod", ["-R", "a-w", dir]);
  } catch (e) {
    removeCheckout(dir);
    throw e;
  }
}

/** Removes a checkout made by reviewCheckout. */
export function removeCheckout(dir: string): void {
  if (!fs.existsSync(dir)) return;
  execFileSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}
