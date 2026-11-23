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
 *   5. server_agent.pin_commit: pr: the commit goes on its own branch,
 *      den/pin-<version>, built from a scratch index so the checkout's
 *      branch and index don't move, and gh opens the pull request. If gh
 *      can't, the branch is pushed and the bell links where to open one;
 *      the next check tries gh again.
 *   6. Issue 160: the approval policy decides (held write den_pin_commit,
 *      routine). When it says ask, Den holds the commit for the person's
 *      Allow, once per version, and commits nothing until then.
 */
import { refusal, type RefusalKey } from "../../shared/held-refusal-words.js";
import type { DetailKey } from "../../shared/review-lines.js";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { agentGitEnv } from "../../shared/agents/git-signing.js";
import type { Ran } from "./den-update.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";

export const PIN_FILES = ["package.json", "package-lock.json"] as const;

/** git with its arguments (and extra env), run in the distribution's root. */
export type GitRun = (
  args: string[],
  env?: Record<string, string>,
) => Promise<Ran>;

/** How the pin leaves: pushed to the branch, or a pull request. */
export type PinMode = "push" | "pr";

/** What the pin step did for a version (pin.json, one per state dir). */
export interface PinRecord {
  version: string;
  state:
    | "pushed"
    | "push_failed"
    | "commit_failed"
    | "clean"
    | "held"
    | "branch_pushed"
    | "pr_opened";
  sha?: string;
  /** pr: the pin's own branch, and the pull request's address. */
  branch?: string;
  url?: string;
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
      /** Issue 577: where it pushed, and git's own output, apart. */
      to?: { remote: string; branch: string; out: string };
      first: boolean;
    }
  | { did: "commit_failed"; version: string; why: string; first: boolean }
  /** The pin files had nothing to commit (someone committed them). */
  | { did: "clean"; version: string }
  /** pr: the branch is pushed and its pull request open. */
  | { did: "pr"; version: string; sha: string; branch: string; url: string }
  /** pr: the branch is pushed, but gh couldn't open the pull request. */
  | {
      did: "branch_pushed";
      version: string;
      sha: string;
      branch: string;
      why: string;
      /** Where to open it by hand (a GitHub remote), or null. */
      link: string | null;
      first: boolean;
    }
  /** Issue 160: held for the person's Allow (the approval policy). */
  | { did: "held"; version: string; first: boolean }
  /** Done before, at an earlier check: nothing to do. */
  | { did: "done"; version: string; how?: PinMode }
  /** Not a git checkout, or no branch to push: nothing Den can do. */
  | {
      did: "skipped";
      version: string;
      why: string;
      /** Issue 577: the reason's key, for the page's language. */
      whyKey?: DetailKey;
    };

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
  writeFileAtomic(p, JSON.stringify(r) + "\n", { mode: 0o600 });
}

const tail = (s: string) =>
  s.trim().split("\n").slice(-2).join(" / ").slice(0, 300) || "no output";

export interface PinCommitDeps {
  /** The distribution's root (where the pin files are). */
  root: string;
  stateDir: string;
  git: GitRun;
  now?: () => number;
  /** server_agent.pin_commit (push by default). */
  mode?: PinMode;
  /** pr: gh as [cmd, ...args] before its own arguments. */
  gh?: string[];
  /** Runs [cmd, ...args] in root (gh); default: execFile. */
  run?: (argv: string[], cwd: string) => Promise<Ran>;
  /** Issue 160: what the approval policy says for den_pin_commit. */
  allow?: () => "run" | "ask";
  /** Issue 160: hold den_pin_commit of `version` for the person. */
  ask?: (version: string) => Promise<boolean> | boolean;
}

/** The pull request's branch for `version`. */
export const pinBranch = (version: string): string => `den/pin-${version}`;

/** A GitHub remote's compare page for `head` onto `base`, or null. */
export function compareLink(
  remoteUrl: string,
  base: string,
  head: string,
): string | null {
  const m = remoteUrl
    .trim()
    .match(
      /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    );
  return m
    ? `https://github.com/${m[1]}/${m[2]}/compare/${base}...${head}?expand=1`
    : null;
}

function runArgv(argv: string[], cwd: string): Promise<Ran> {
  return new Promise((resolve) =>
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        timeout: 60_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (err, stdout, stderr) =>
        resolve({
          code: err
            ? typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : null
            : 0,
          out: `${stdout ?? ""}${stderr ?? ""}${err && typeof (err as { code?: unknown }).code !== "number" ? String(err) : ""}`,
        }),
    ),
  );
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
  if (same?.state === "pr_opened") return { did: "done", version, how: "pr" };
  const mode: PinMode = d.mode ?? "push";
  try {
    const top = await d.git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0)
      return skipped(version, "ap.err.pinNotCheckout", { root: d.root });
    const up = await upstream(d.git);
    if (!up) return skipped(version, "ap.err.pinDetached");

    // A commit an earlier pass made (its push or its pull request failed).
    let sha =
      same?.state === "push_failed" || same?.state === "branch_pushed"
        ? same.sha
        : undefined;
    const branch = same?.branch ?? pinBranch(version);
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
      // Issue 160: the policy says ask: hold it, once per version.
      if (d.allow?.() === "ask") {
        if (same?.state === "held")
          return { did: "held", version, first: false };
        await d.ask?.(version);
        writePinRecord(d.stateDir, {
          version,
          state: "held",
          noted: true,
          at: at(),
        });
        return { did: "held", version, first: true };
      }
      const subject = `Den ${version}: pin the distribution to Den ${version}`;
      const body =
        "Den committed this pin itself after its update to this version was verified.";
      if (mode === "pr") {
        // A scratch index: the checkout's branch and index stay as they are.
        const idx = path.join(
          path.dirname(pinRecordFile(d.stateDir)),
          "pin-index",
        );
        fs.mkdirSync(path.dirname(idx), { recursive: true, mode: 0o700 });
        fs.rmSync(idx, { force: true });
        const ienv = { GIT_INDEX_FILE: idx };
        try {
          const rt = await d.git(["read-tree", "HEAD"], ienv);
          if (rt.code !== 0)
            return failCommit(`git read-tree: ${tail(rt.out)}`);
          const add = await d.git(["add", "--", ...files], ienv);
          if (add.code !== 0) return failCommit(`git add: ${tail(add.out)}`);
          const wt = await d.git(["write-tree"], ienv);
          if (wt.code !== 0)
            return failCommit(`git write-tree: ${tail(wt.out)}`);
          const ct = await d.git([
            "commit-tree",
            wt.out.trim(),
            "-p",
            "HEAD",
            "-m",
            subject,
            "-m",
            body,
          ]);
          if (ct.code !== 0)
            return failCommit(`git commit-tree: ${tail(ct.out)}`);
          sha = ct.out.trim();
        } finally {
          fs.rmSync(idx, { force: true });
        }
      } else {
        const add = await d.git(["add", "--", ...files]);
        if (add.code !== 0) return failCommit(`git add: ${tail(add.out)}`);
        const c = await d.git([
          "commit",
          "--only",
          "-q",
          "-m",
          subject,
          "-m",
          body,
          "--",
          ...files,
        ]);
        if (c.code !== 0) return failCommit(`git commit: ${tail(c.out)}`);
        const h = await d.git(["rev-parse", "HEAD"]);
        sha = h.out.trim();
      }
    }

    if (mode === "pr")
      return await openPr(version, sha, branch, up, same, d, at);

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
    return pushFailed(
      version,
      sha,
      { remote: up.remote, branch: up.branch, out: tail(p.out) },
      same,
      d,
      at,
    );
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

function pushFailed(
  version: string,
  sha: string,
  to: { remote: string; branch: string; out: string },
  same: PinRecord | null,
  d: PinCommitDeps,
  at: () => string,
  branch?: string,
): PinStep {
  const first = !(same?.state === "push_failed" && same.noted);
  const why = `git push to ${to.remote} ${to.branch}: ${to.out}`;
  writePinRecord(d.stateDir, {
    version,
    state: "push_failed",
    sha,
    why,
    noted: true,
    at: at(),
    ...(branch ? { branch } : {}),
  });
  return { did: "push_failed", version, sha, why, to, first };
}

/** pr: push the pin's branch (unless pushed), then gh opens the PR. */
async function openPr(
  version: string,
  sha: string,
  branch: string,
  up: { remote: string; branch: string },
  same: PinRecord | null,
  d: PinCommitDeps,
  at: () => string,
): Promise<PinStep> {
  if (same?.state !== "branch_pushed") {
    const p = await d.git([
      "push",
      "--quiet",
      up.remote,
      `${sha}:refs/heads/${branch}`,
    ]);
    if (p.code !== 0)
      return pushFailed(
        version,
        sha,
        { remote: up.remote, branch, out: tail(p.out) },
        same,
        d,
        at,
        branch,
      );
  }
  const run = d.run ?? runArgv;
  const gh = await run(
    [
      ...(d.gh ?? ["gh"]),
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      up.branch,
      "--title",
      `Den ${version}: pin the distribution to Den ${version}`,
      "--body",
      `Den updated itself to ${version} and verified it. This pull request commits the new pin (package.json, package-lock.json), nothing else.`,
    ],
    d.root,
  ).catch((e: unknown) => ({ code: null, out: String(e) }) as Ran);
  const url = gh.out.match(/https?:\/\/\S+/)?.[0];
  if (gh.code === 0 && url) {
    writePinRecord(d.stateDir, {
      version,
      state: "pr_opened",
      sha,
      branch,
      url,
      at: at(),
    });
    return { did: "pr", version, sha, branch, url };
  }
  const why = `gh pr create: ${tail(gh.out)}`;
  const r = await d.git(["remote", "get-url", up.remote]);
  const link = r.code === 0 ? compareLink(r.out, up.branch, branch) : null;
  const first = !(same?.state === "branch_pushed" && same.noted);
  writePinRecord(d.stateDir, {
    version,
    state: "branch_pushed",
    sha,
    branch,
    why,
    noted: true,
    at: at(),
  });
  return { did: "branch_pushed", version, sha, branch, why, link, first };
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
  const raw = (args: string[], extra?: Record<string, string>) =>
    new Promise<Ran>((resolve) =>
      execFile(
        "git",
        ["-C", root, ...pre, ...args],
        {
          env: extra ? { ...env, ...extra } : env,
          timeout: o.timeoutMs ?? 60_000,
          maxBuffer: 4 * 1024 * 1024,
        },
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
  return async (args, extra) => {
    if (args[0] !== "commit" && args[0] !== "commit-tree")
      return raw(args, extra);
    // commit-tree signs only when told to (-S): with the key set, it is.
    const a =
      args[0] === "commit-tree" && o.signingKey
        ? ["commit-tree", "-S", ...args.slice(1)]
        : args;
    ident ??= raw(["config", "--get", "user.email"]).then(
      (r) => r.code === 0 && !!r.out.trim(),
    );
    if (await ident) return raw(a, extra);
    return raw(
      [
        "-c",
        `user.name=${DEN_IDENT.name}`,
        "-c",
        `user.email=${DEN_IDENT.email}`,
        ...a,
      ],
      extra,
    );
  };
}

/** Issue 577: a skipped step, its English and its key from one catalog. */
function skipped(
  version: string,
  key: RefusalKey,
  vars?: Record<string, string>,
): PinStep {
  const r = refusal(key, vars);
  return { did: "skipped", version, why: r.error, whyKey: r.errorKey };
}

/**
 * Issue 577: why an Allowed pin commit didn't finish, as a key for the
 * page's language (null: it finished, or has no reason). Git's and gh's
 * own output stays as they said it, in a var.
 */
export function pinRefusalKey(step: PinStep): DetailKey | null {
  const key = (k: RefusalKey, vars: Record<string, string>) =>
    refusal(k, vars).errorKey;
  switch (step.did) {
    case "skipped":
      return step.whyKey ?? null;
    case "push_failed":
      return step.to
        ? key("ap.err.pinPush", { ...step.to })
        : key("ap.err.pinCommit", { why: step.why });
    case "commit_failed":
      return key("ap.err.pinCommit", { why: step.why });
    case "branch_pushed":
      return key("ap.err.pinBranch", { branch: step.branch, why: step.why });
    default:
      return null;
  }
}

/**
 * #176: the bell's note for a pin step: its English, its key and vars
 * (issue 577: Den's words never baked into a var), and where it links.
 * Null: the step has no note.
 */
export function pinBellMsg(
  step: PinStep,
  t: string,
): {
  text: string;
  key: string;
  vars: Record<string, string>;
  link?: string | null;
} | null {
  const v = step.version;
  switch (step.did) {
    case "pushed": {
      const sha = step.sha.slice(0, 12);
      return {
        text: `${t} updated to ${v}: its pin is committed (${sha}) and pushed`,
        key: "bell.m.pinPushed",
        vars: { v, sha },
      };
    }
    case "push_failed": {
      const sha = step.sha.slice(0, 12);
      if (step.to)
        return {
          text: `${t} ${v}: its pin is committed (${sha}) but the push to ${step.to.remote} ${step.to.branch} failed: ${step.to.out}. ${t} tries again at the next update check`,
          key: "bell.m.pinPushFailedTo",
          vars: { v, sha, ...step.to },
        };
      return {
        text: `${t} ${v}: its pin is committed (${sha}) but the push failed: ${step.why}. ${t} tries again at the next update check`,
        key: "bell.m.pinPushFailed",
        vars: { v, sha, why: step.why },
      };
    }
    case "commit_failed":
      return {
        text: `${t} ${v}: ${t} couldn't commit its pin: ${step.why}. It tries again at the next update check`,
        key: "bell.m.pinCommitFailed",
        vars: { v, why: step.why },
      };
    case "pr":
      return {
        text: `${t} updated to ${v}: its pin is in a pull request (${step.branch})`,
        key: "bell.m.pinPrOpened",
        vars: { v, branch: step.branch },
        link: step.url,
      };
    case "branch_pushed":
      return {
        text: `${t} ${v}: the pin branch ${step.branch} is pushed; open a pull request for it (${step.why})`,
        key: "bell.m.pinBranchPushed",
        vars: { v, branch: step.branch, why: step.why },
        link: step.link ?? "/server-agent",
      };
    case "held":
      return {
        text: `${t} ${v}: committing its pin waits for your Allow`,
        key: "bell.m.pinHeld",
        vars: { v },
      };
    default:
      return null;
  }
}
