#!/usr/bin/env node
/**
 * Issue 185: the fast checks the pre-push hook (.husky/pre-push) runs on
 * each pushed ref, besides the org-name gate, so a push is refused for what
 * CI would fail on a minute later:
 *
 *   - tests/unit/version-sync.test.ts (a CHANGELOG section with no version
 *     bump, or a lock that disagrees);
 *   - tests/unit/cli/no-localhost-in-cli-output.test.ts (D80: the CLI
 *     never prints localhost to a person);
 *   - scripts/words-gate.mjs against the base;
 *   - no new commit says Closes, Fixes or Resolves for an issue that is
 *     still open: an issue closes after the release, once the person who
 *     reported it has seen it live, and GitHub closes it from a commit
 *     message the moment the commit reaches main. Commits say "Refs #N".
 *
 * The tests and the gate run on the pushed commit itself, in a throwaway
 * worktree (never the working tree, which may hold other changes), with
 * the checkout's node_modules. No browser; seconds.
 *
 *   node scripts/pre-push-checks.mjs <base> <sha>
 *
 * Exit 0 when all pass, 1 when one fails (each failing check is named).
 * DEN_PREPUSH_CHECKS=0 skips them all. Run in the repository being pushed.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = [
  "tests/unit/version-sync.test.ts",
  "tests/unit/cli/no-localhost-in-cli-output.test.ts",
];

/**
 * The issue numbers a commit message closes by keyword (GitHub's: close,
 * closes, closed, fix, fixes, fixed, resolve, resolves, resolved, then
 * #N or owner/repo#N, a colon allowed). "Refs #N" closes nothing.
 */
export function closingRefs(text) {
  const out = new Set();
  const re =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  for (const m of String(text ?? "").matchAll(re)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 << 20, ...opts });

/** "OPEN", "CLOSED", or "" when gh can't say (none installed, offline). */
function issueState(n, cwd) {
  const r = run(
    "gh",
    ["issue", "view", String(n), "--json", "state", "-q", ".state"],
    {
      cwd,
    },
  );
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Problems with the new commits' closing keywords ([] when none). */
function closingProblems(base, sha, cwd) {
  const log = run("git", ["log", "--format=%H%x00%B%x01", `${base}..${sha}`], {
    cwd,
  });
  if (log.status !== 0) return [`can't read the commits ${base}..${sha}`];
  const out = [];
  for (const entry of log.stdout.split("\x01")) {
    const [id, body] = entry.trim().split("\x00");
    if (!id) continue;
    for (const n of closingRefs(body)) {
      const state = issueState(n, cwd);
      if (state === "CLOSED") continue;
      out.push(
        `commit ${id.slice(0, 12)} closes #${n}, ${state === "OPEN" ? "which is still open" : "and gh can't say whether it is still open"}: say "Refs #${n}" instead (it closes once the release is live and seen)`,
      );
    }
  }
  return out;
}

/** The tests and the words gate on `sha`, in a throwaway worktree. */
function treeProblems(base, sha, cwd) {
  const top = run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  }).stdout.trim();
  const modules = path.join(top || cwd, "node_modules");
  if (!fs.existsSync(modules))
    return [`no node_modules in ${top || cwd}: run npm ci, then push again`];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-prepush-"));
  const wt = path.join(dir, "tree");
  const out = [];
  try {
    const add = run(
      "git",
      ["worktree", "add", "--quiet", "--detach", wt, sha],
      {
        cwd,
      },
    );
    if (add.status !== 0)
      return [`can't check out ${sha.slice(0, 12)}: ${add.stderr.trim()}`];
    fs.symlinkSync(modules, path.join(wt, "node_modules"));
    // A clean environment: no jest worker or session state of the caller.
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (/^(JEST_|DEN_ROOT$|DEN_WORDS_)/.test(k)) delete env[k];
    const jest = run(
      process.execPath,
      [
        path.join(wt, "node_modules", "jest", "bin", "jest.js"),
        "--silent",
        "--ci",
        ...TESTS,
      ],
      { cwd: wt, env },
    );
    if (jest.status !== 0) {
      const failed = [
        ...`${jest.stdout}${jest.stderr}`.matchAll(/^FAIL\s+(\S+)/gm),
      ].map((m) => m[1]);
      for (const t of failed.length ? failed : TESTS)
        out.push(`${t} fails on this commit (run: npx jest ${t})`);
    }
    const words = run(
      process.execPath,
      [path.join(wt, "scripts", "words-gate.mjs")],
      {
        cwd: wt,
        env: { ...env, DEN_WORDS_BASE: base },
      },
    );
    if (words.status !== 0)
      out.push(
        `the words gate (scripts/words-gate.mjs): ${`${words.stdout}${words.stderr}`.trim().split("\n").slice(0, 6).join("\n    ")}`,
      );
  } finally {
    run("git", ["worktree", "remove", "--force", wt], { cwd });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

function main(argv) {
  if (process.env.DEN_PREPUSH_CHECKS === "0") return 0;
  const [base, sha] = argv;
  if (!base || !sha) {
    console.error("usage: node scripts/pre-push-checks.mjs <base> <sha>");
    return 2;
  }
  const cwd = process.cwd();
  const problems = [
    ...closingProblems(base, sha, cwd),
    ...treeProblems(base, sha, cwd),
  ];
  for (const p of problems) console.error(`pre-push: ${p}`);
  return problems.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
