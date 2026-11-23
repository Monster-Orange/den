/**
 * Issue 476 (REVIEW-MESH-SPEC RV-4, RV-8 item 16): a review leg's folder.
 *
 *   <dir>/          the leg's working folder (read-only, nothing else in it)
 *   <dir>/head/     the PR's head: a local clone, remote removed, every push
 *                   URL rewritten to one git can't use, no credential helper,
 *                   no hooks
 *   <dir>/base/     the base ref's instruction files only (CLAUDE.md,
 *                   AGENTS.md, .claude/rules/*.md): what the leg follows
 *
 * The head's own agent config (.claude/, .mcp.json, CLAUDE.md, AGENTS.md)
 * is removed at any depth, so a PR can't hand its reviewer hooks, allow
 * rules, MCP servers or orders; its edits to them stay reviewable through
 * git (`git show HEAD:CLAUDE.md`), as data. Den fetched both refs into
 * `repoPath` first; the clone never talks to GitHub.
 *
 * Read-only files are a convenience only: the leg runs as this user, who
 * can undo a chmod, and gh keeps its login outside the environment. The
 * guard is the leg's launch (den-claude REVIEW_LEG_DENY, user-only
 * settings, Den's server limited to review_submit) under the "ask" intent.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const SHA_RE = /^[0-9a-f]{40}$/;

/** Agent config a runtime would load from a folder: never from a head. */
const AGENT_CONFIG = new Set([
  ".claude",
  ".mcp.json",
  "CLAUDE.md",
  "AGENTS.md",
]);

/** The base's instruction files a leg follows (instructions.ts reads them). */
const INSTRUCTION_RE =
  /(^|\/)(CLAUDE\.md|AGENTS\.md)$|^\.claude\/rules\/[^/]+\.md$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function stripAgentConfig(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (AGENT_CONFIG.has(e.name))
      fs.rmSync(p, { recursive: true, force: true });
    else if (e.isDirectory() && !e.isSymbolicLink()) stripAgentConfig(p);
  }
}

export interface LegFolders {
  /** The leg's working folder. */
  dir: string;
  /** The PR's head, stripped of agent config. */
  head: string;
  /** The base ref's instruction files. */
  base: string;
}

/**
 * Makes the leg's folder at `dir` (which must not exist): the head and the
 * base's instruction files, all read-only. Both must be full commit ids
 * already in `repoPath`.
 */
export function reviewCheckout(
  repoPath: string,
  refs: { head: string; base: string },
  dir: string,
): LegFolders {
  if (!SHA_RE.test(refs.head) || !SHA_RE.test(refs.base))
    throw new Error("the head and the base must be full commit ids");
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  const head = path.join(dir, "head");
  const base = path.join(dir, "base");
  fs.mkdirSync(base, { recursive: true });
  try {
    git(repoPath, [
      "clone",
      "-q",
      "--no-checkout",
      "--no-hardlinks",
      "--",
      repoPath,
      head,
    ]);
    git(head, [
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "-q",
      "--detach",
      refs.head,
    ]);
    git(head, ["remote", "remove", "origin"]);
    git(head, ["config", "url.no-push://den-review-leg/.pushInsteadOf", ""]);
    git(head, ["config", "credential.helper", ""]);
    git(head, ["config", "core.hooksPath", "/dev/null"]);
    stripAgentConfig(head);
    const names = git(repoPath, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      refs.base,
    ])
      .split("\0")
      .filter((n) => INSTRUCTION_RE.test(n) && !n.split("/").includes(".."));
    for (const n of names) {
      const out = path.join(base, n);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        git(repoPath, ["show", `${refs.base}:${n}`]) + "\n",
      );
    }
    execFileSync("chmod", ["-R", "a-w", dir]);
  } catch (e) {
    removeCheckout(dir);
    throw e;
  }
  return { dir, head, base };
}

/** Removes a checkout made by reviewCheckout. */
export function removeCheckout(dir: string): void {
  if (!fs.existsSync(dir)) return;
  execFileSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}
