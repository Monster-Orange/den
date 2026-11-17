/**
 * #176: after Den updates itself, Den commits and pushes the distribution's
 * new pin (package.json, package-lock.json) as its own step. It was the
 * server agent's job, and an agent that was resumed, busy or not running
 * dropped it (2026-11-16: a person pushed the pin by hand).
 *
 * The update check (update-check.ts) calls commitPin once the new version
 * is verified (the watch wrote "good" and this Den runs it), on the lead
 * install only (LEAD-1..4: a follower applies the pin, never moves it):
 *
 *   1. Only the two pin files are staged, by path, and the commit takes
 *      only them (`git commit --only`): anything else dirty or staged in
 *      the checkout stays as it was.
 *   2. Signing as the install is set up: agents.git.signing_key signs it
 *      (an SSH key, gpg.format ssh, ssh-keygen as the signer); with no key
 *      set it is unsigned (commit.gpgsign false). Never the person's GPG
 *      key, never a prompt (GIT_TERMINAL_PROMPT 0).
 *   3. It pushes to the branch's own upstream (branch.<b>.remote and
 *      branch.<b>.merge; origin and the same name when unset).
 *   4. A push that fails (offline, rejected) keeps the commit and its sha
 *      in <state>/server-agent/update/pin.json; the next check pushes it
 *      again. `first` is true once per version, so the bell says it once.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { agentGitEnv } from "../../shared/agents/git-signing.js";
import type { Ran } from "./den-update.js";

export const PIN_FILES = ["package.json", "package-lock.json"] as const;

/** git with its arguments, run in the distribution's root. */
export type GitRun = (args: string[]) => Promise<Ran>;

/** What the pin step did for a version (pin.json, one per state dir). */
export interface PinRecord {
  version: string;
  state: "pushed" | "push_failed" | "commit_failed" | "clean";
  sha?: string;
  why?: string;
  /** The bell has said this failure already. */
  noted?: boolean;
  at: string;
}

export type PinStep =
  /** Committed (now or before) and pushed. */
  | { did: "pushed"; version: string; sha: string }
  | {
      did: "push_failed";
      version: string;
      sha: string;
      why: string;
      first: boolean;
    }
  | { did: "commit_failed"; version: string; why: string; first: boolean }
  /** The pin files had nothing to commit (someone committed them). */
  | { did: "clean"; version: string }
  /** Done before, at an earlier check: nothing to do. */
  | { did: "done"; version: string }
  /** Not a git checkout, or no branch to push: nothing Den can do. */
  | { did: "skipped"; version: string; why: string };

export const pinRecordFile = (stateDir: string): string =>
  path.join(stateDir, "server-agent", "update", "pin.json");

export function readPinRecord(stateDir: string): PinRecord | null {
  try {
    const r = JSON.parse(
      fs.readFileSync(pinRecordFile(stateDir), "utf8"),
    ) as PinRecord;
    return typeof r?.version === "string" && typeof r.state === "string"
      ? r
      : null;
  } catch {
    return null;
  }
}

function writePinRecord(stateDir: string, r: PinRecord): void {
  const p = pinRecordFile(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

const tail = (s: string) =>
  s.trim().split("\n").slice(-2).join(" / ").slice(0, 300) || "no output";

export interface PinCommitDeps {
  /** The distribution's root (where the pin files are). */
  root: string;
  stateDir: string;
  git: GitRun;
  now?: () => number;
}

/** Where the checkout's branch pushes: its upstream, or origin and its name. */
async function upstream(
  git: GitRun,
): Promise<{ remote: string; branch: string } | null> {
  const b = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = b.code === 0 ? b.out.trim() : "";
  if (!branch) return null;
  const r = await git(["config", "--get", `branch.${branch}.remote`]);
  const m = await git(["config", "--get", `branch.${branch}.merge`]);
  return {
    remote: (r.code === 0 && r.out.trim()) || "origin",
    branch:
      (m.code === 0 && m.out.trim().replace(/^refs\/heads\//, "")) || branch,
  };
}

/**
 * #176: commit the pin of `version` (only the pin files) and push it, or
 * push a commit an earlier check couldn't. Never throws.
 */
export async function commitPin(
  version: string,
  d: PinCommitDeps,
): Promise<PinStep> {
  const now = d.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const rec = readPinRecord(d.stateDir);
  const same = rec?.version === version ? rec : null;
  if (same && (same.state === "pushed" || same.state === "clean"))
    return { did: "done", version };
  try {
    const top = await d.git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0)
      return {
        did: "skipped",
        version,
        why: `${d.root} is not a git checkout`,
      };
    const up = await upstream(d.git);
    if (!up)
      return {
        did: "skipped",
        version,
        why: "the distribution's checkout is on no branch (detached HEAD)",
      };

    let sha = same?.state === "push_failed" ? same.sha : undefined;
    if (!sha) {
      const files = PIN_FILES.filter((f) =>
        fs.existsSync(path.join(d.root, f)),
      );
      const st = await d.git(["status", "--porcelain", "--", ...files]);
      if (st.code !== 0) throw new Error(`git status: ${tail(st.out)}`);
      if (!st.out.trim()) {
        writePinRecord(d.stateDir, { version, state: "clean", at: at() });
        return { did: "clean", version };
      }
      const failCommit = (why: string): PinStep => {
        const first = !(same?.state === "commit_failed" && same.noted);
        writePinRecord(d.stateDir, {
          version,
          state: "commit_failed",
          why,
          noted: true,
          at: at(),
        });
        return { did: "commit_failed", version, why, first };
      };
      const add = await d.git(["add", "--", ...files]);
      if (add.code !== 0) return failCommit(`git add: ${tail(add.out)}`);
      const c = await d.git([
        "commit",
        "--only",
        "-q",
        "-m",
        `Den ${version}: pin the distribution to Den ${version}`,
        "-m",
        "Den committed this pin itself after its update to this version was verified.",
        "--",
        ...files,
      ]);
      if (c.code !== 0) return failCommit(`git commit: ${tail(c.out)}`);
      const h = await d.git(["rev-parse", "HEAD"]);
      sha = h.out.trim();
    }

    const p = await d.git([
      "push",
      "--quiet",
      up.remote,
      `${sha}:refs/heads/${up.branch}`,
    ]);
    if (p.code === 0) {
      writePinRecord(d.stateDir, { version, state: "pushed", sha, at: at() });
      return { did: "pushed", version, sha };
    }
    const why = `git push to ${up.remote} ${up.branch}: ${tail(p.out)}`;
    const first = !(same?.state === "push_failed" && same.noted);
    writePinRecord(d.stateDir, {
      version,
      state: "push_failed",
      sha,
      why,
      noted: true,
      at: at(),
    });
    return { did: "push_failed", version, sha, why, first };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const first = !(same?.state === "commit_failed" && same.noted);
    writePinRecord(d.stateDir, {
      version,
      state: "commit_failed",
      why,
      noted: true,
      at: at(),
    });
    return { did: "commit_failed", version, why, first };
  }
}

/** The fallback author when the checkout has no user.email set. */
const DEN_IDENT = { name: "Den agent", email: "den-agent@den.invalid" };

/**
 * #176: the real git for commitPin, in `root`. Signing as configured
 * (agents.git.signing_key, or unsigned); never a prompt.
 */
export function pinGit(
  root: string,
  o: {
    env?: NodeJS.ProcessEnv;
    /** agents.git.signing_key's absolute path, or undefined (unsigned). */
    signingKey?: string;
    timeoutMs?: number;
  } = {},
): GitRun {
  const base = o.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    ...agentGitEnv(o.signingKey ? { signingKey: o.signingKey } : undefined),
  };
  // Signing configured: ssh-keygen with the agents' key, whatever signer
  // the person's own config names. Not configured: never sign (a person's
  // commit.gpgsign would reach for their GPG key).
  const pre = o.signingKey
    ? ["-c", "gpg.ssh.program=ssh-keygen"]
    : ["-c", "commit.gpgsign=false"];
  const raw = (args: string[]) =>
    new Promise<Ran>((resolve) =>
      execFile(
        "git",
        ["-C", root, ...pre, ...args],
        { env, timeout: o.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? null
                : 0;
          resolve({
            code,
            out: `${stdout ?? ""}${stderr ?? ""}${err && code === null ? String(err) : ""}`,
          });
        },
      ),
    );
  let ident: Promise<boolean> | undefined;
  return async (args) => {
    if (args[0] !== "commit") return raw(args);
    ident ??= raw(["config", "--get", "user.email"]).then(
      (r) => r.code === 0 && !!r.out.trim(),
    );
    if (await ident) return raw(args);
    return raw([
      "-c",
      `user.name=${DEN_IDENT.name}`,
      "-c",
      `user.email=${DEN_IDENT.email}`,
      ...args,
    ]);
  };
}
