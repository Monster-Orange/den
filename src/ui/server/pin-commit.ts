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
 *   1. Only the two pin files go in, from a scratch index read from the
 *      branch's tip on the remote (issue 1195: fetched first, or the last
 *      one fetched; never local HEAD, so commits not pushed yet never ride
 *      along). Anything else dirty or staged in the checkout stays as it
 *      was. In push mode the checkout's branch takes the pin commit only
 *      when it was on that tip.
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
 *      den/pin-<version> (the checkout's branch and index don't move), and
 *      gh opens the pull request. If gh
 *      can't, the branch is pushed and the bell links where to open one;
 *      the next check tries gh again.
 *   6. Issue 160: the approval policy decides (held write den_pin_commit,
 *      routine). When it says ask, Den holds the commit for the person's
 *      Allow, once per version, and commits nothing until then.
 *   7. Issue 1189: set to push, Den first asks GitHub for the branch's
 *      rules (gh api repos/<owner>/<repo>/rules/branches/<branch>). Rules
 *      that need a status check or a pull request: this update goes the
 *      pr way, with no push tried. A push a branch rule still rejects
 *      (GH006, GH013, a required check or review) falls back the same way:
 *      the checkout's branch goes back off the pin commit (only if it is
 *      still on it), and the pin goes to den/pin-<version> and its pull
 *      request. The step says why (`via`), so the bell and doctor say so
 *      every time. Any other push failure (offline, auth) keeps step 4.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { agentGitEnv } from "../../shared/agents/git-signing.js";
import type { Ran } from "./den-update.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
  pinRecordFile,
  pullNumber,
  readPinRecord,
  type PinRecord,
  type PinVia,
} from "../../shared/pin-record.js";

// Moved to src/shared/pin-record.ts (doctor reads it too); kept here.
export { pinRecordFile, readPinRecord, type PinRecord, type PinVia };

export const PIN_FILES = ["package.json", "package-lock.json"] as const;

/** git with its arguments (and extra env), run in the distribution's root. */
export type GitRun = (
  args: string[],
  env?: Record<string, string>,
) => Promise<Ran>;

/** How the pin leaves: pushed to the branch, or a pull request. */
export type PinMode = "push" | "pr";

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
  /** pr: the branch is pushed and its pull request open. */
  | {
      did: "pr";
      version: string;
      sha: string;
      branch: string;
      url: string;
      /** Issue 1189: set to push, it went this way, and why. */
      via?: PinVia;
    }
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
      via?: PinVia;
    }
  /** Issue 160: held for the person's Allow (the approval policy). */
  | { did: "held"; version: string; first: boolean }
  /** Done before, at an earlier check: nothing to do. */
  | { did: "done"; version: string; how?: PinMode }
  /** Not a git checkout, or no branch to push: nothing Den can do. */
  | { did: "skipped"; version: string; why: string };

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
  const gh = githubRepo(remoteUrl);
  return gh
    ? `https://github.com/${gh.owner}/${gh.repo}/compare/${base}...${head}?expand=1`
    : null;
}

/**
 * A GitHub remote's owner and repo, or null. The host must be github.com
 * itself (issue 1189): an https or ssh address whose host is github.com,
 * or scp-style user@github.com:owner/repo. A look-alike host
 * (notgithub.com, github.com.example) or a path with github.com in it is
 * not GitHub.
 */
export function githubRepo(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const m = remoteUrl
    .trim()
    .match(
      /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/|[^@/:]+@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Issue 1189: the branch rule types that a direct push can't satisfy. */
const PR_RULES = new Set([
  "pull_request",
  "required_status_checks",
  "merge_queue",
  "required_deployments",
  "workflows",
]);

/**
 * Issue 1189: a push rejected by a branch rule (GitHub's GH006 for a
 * protected branch, GH013 for a ruleset, or the words they use), not by
 * the network or the sign-in.
 */
export function ruleRejected(out: string): boolean {
  return /\bGH0(?:06|13)\b|protected branch|required status check|repository rule violations|changes must be made through a pull request|review is required/i.test(
    out,
  );
}

/** The remote's address as configured (before any insteadOf). */
async function remoteUrl(git: GitRun, remote: string): Promise<string> {
  const r = await git(["config", "--get", `remote.${remote}.url`]);
  return r.code === 0 ? r.out.trim() : "";
}

/**
 * Issue 1189: does `branch` on this GitHub remote have rules a direct push
 * can't meet? true, false, or null when GitHub can't say (not GitHub, no
 * gh, offline): then the push goes ahead, and a rejection still falls back.
 */
async function branchNeedsPr(
  url: string,
  branch: string,
  d: PinCommitDeps,
): Promise<boolean | null> {
  const gh = githubRepo(url);
  if (!gh) return null;
  const run = d.run ?? runArgv;
  const r = await run(
    [
      ...(d.gh ?? ["gh"]),
      "api",
      `repos/${gh.owner}/${gh.repo}/rules/branches/${encodeURIComponent(branch)}`,
    ],
    d.root,
  ).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const rules = JSON.parse(r.out) as unknown;
    if (!Array.isArray(rules)) return null;
    return rules.some(
      (x) =>
        !!x &&
        typeof (x as { type?: unknown }).type === "string" &&
        PR_RULES.has((x as { type: string }).type),
    );
  } catch {
    return null;
  }
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
  let mode: PinMode = d.mode ?? "push";
  // Issue 1189: a pull request this version fell back to stays one.
  let via: PinVia | undefined =
    same?.state === "branch_pushed" ? same.via : undefined;
  if (via) mode = "pr";
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
      // Issue 1189: rules that need a pull request: go that way at once.
      if (
        mode === "push" &&
        (await branchNeedsPr(await remoteUrl(d.git, up.remote), up.branch, d))
      ) {
        mode = "pr";
        via = "rules";
      }
      // Issue 1195: the pin goes on the branch's tip on the remote, fetched
      // now, never local HEAD: commits not pushed yet never ride along.
      const tip = await remoteTip(d.git, up);
      if (!tip)
        return failCommit(
          `can't reach ${up.remote} to find the tip of ${up.branch}, and it was never fetched`,
        );
      const subject = `Den ${version}: pin the distribution to Den ${version}`;
      const body =
        "Den committed this pin itself after its update to this version was verified.";
      // A scratch index from the tip: the checkout's branch and index stay
      // as they are, and the commit's tree is the tip's with only the pin
      // files from the checkout.
      const idx = path.join(
        path.dirname(pinRecordFile(d.stateDir)),
        "pin-index",
      );
      fs.mkdirSync(path.dirname(idx), { recursive: true, mode: 0o700 });
      fs.rmSync(idx, { force: true });
      const ienv = { GIT_INDEX_FILE: idx };
      try {
        const rt = await d.git(["read-tree", tip], ienv);
        if (rt.code !== 0) return failCommit(`git read-tree: ${tail(rt.out)}`);
        const add = await d.git(["add", "--", ...files], ienv);
        if (add.code !== 0) return failCommit(`git add: ${tail(add.out)}`);
        const wt = await d.git(["write-tree"], ienv);
        if (wt.code !== 0) return failCommit(`git write-tree: ${tail(wt.out)}`);
        const ct = await d.git([
          "commit-tree",
          wt.out.trim(),
          "-p",
          tip,
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
      // Push mode, a checkout on that tip (nothing unpushed): its branch
      // takes the pin commit, as a commit there would have, and the pin
      // files' index entries match it. Behind or ahead: it stays as it is.
      if (mode === "push") await takePin(d.git, tip, sha);
    }

    if (mode === "pr")
      return await openPr(version, sha, branch, up, same, d, at, via);

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
    // Issue 1189: a branch rule said no: the pin goes to a pull request.
    if (ruleRejected(p.out)) {
      // A branch that took the pin commit steps back off it; one that moved
      // meanwhile keeps it, and the record says so (doctor shows it).
      const h = await d.git(["rev-parse", "HEAD"]);
      const onPin = h.code === 0 && h.out.trim() === sha;
      const back = onPin ? await stepBack(d.git, sha) : true;
      return await openPr(
        version,
        sha,
        branch,
        up,
        same,
        d,
        at,
        "rejected",
        back ? undefined : "the local branch still has the pin commit",
      );
    }
    return pushFailed(
      version,
      sha,
      `git push to ${up.remote} ${up.branch}: ${tail(p.out)}`,
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

/**
 * Issue 1195: the tip of the branch the pin goes to, on the remote:
 * fetched now, or the last one fetched when the remote can't be reached.
 * null when there is neither (a pin built on local HEAD could carry
 * commits that were never pushed).
 */
async function remoteTip(
  git: GitRun,
  up: { remote: string; branch: string },
): Promise<string | null> {
  const f = await git([
    "fetch",
    "--quiet",
    "--no-tags",
    up.remote,
    `refs/heads/${up.branch}`,
  ]);
  const ref =
    f.code === 0 ? "FETCH_HEAD" : `refs/remotes/${up.remote}/${up.branch}`;
  const r = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}

/**
 * Issue 1195: the checkout's branch takes the pin commit only when it is
 * on `tip` (update-ref checks it); the pin files' index entries then match
 * it, as `git commit --only` left them. Nothing else moves.
 */
async function takePin(git: GitRun, tip: string, sha: string): Promise<void> {
  const b = await git(["symbolic-ref", "-q", "HEAD"]);
  const ref = b.code === 0 ? b.out.trim() : "";
  if (!ref) return;
  const moved = await git(["update-ref", ref, sha, tip]);
  if (moved.code !== 0) return;
  await git(["reset", "-q", "--", ...PIN_FILES]);
}

/**
 * Issue 1189: the push of the pin commit was refused by a branch rule, so
 * the checkout's branch goes back to the commit before it, the pin still
 * in its files, as it was before the commit. Only when the branch is still
 * on that commit (update-ref checks it), and only the pin files' index
 * entries move; nothing else the person has staged or changed.
 */
async function stepBack(git: GitRun, sha: string): Promise<boolean> {
  const b = await git(["symbolic-ref", "-q", "HEAD"]);
  const ref = b.code === 0 ? b.out.trim() : "";
  if (!ref) return false;
  const parent = await git(["rev-parse", "--verify", "-q", `${sha}^`]);
  if (parent.code !== 0) return false;
  const moved = await git(["update-ref", ref, parent.out.trim(), sha]);
  if (moved.code !== 0) return false;
  await git(["reset", "-q", "--", ...PIN_FILES]);
  return true;
}

function pushFailed(
  version: string,
  sha: string,
  why: string,
  same: PinRecord | null,
  d: PinCommitDeps,
  at: () => string,
  branch?: string,
): PinStep {
  const first = !(same?.state === "push_failed" && same.noted);
  writePinRecord(d.stateDir, {
    version,
    state: "push_failed",
    sha,
    why,
    noted: true,
    at: at(),
    ...(branch ? { branch } : {}),
  });
  return { did: "push_failed", version, sha, why, first };
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
  via?: PinVia,
  /** Issue 1189: something the person should know (kept as `why`). */
  note?: string,
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
        `git push to ${up.remote} ${branch}: ${tail(p.out)}`,
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
      ...(via ? { via } : {}),
      ...(note ? { why: note } : {}),
      at: at(),
    });
    return { did: "pr", version, sha, branch, url, ...(via ? { via } : {}) };
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
    ...(via ? { via } : {}),
    at: at(),
  });
  return {
    did: "branch_pushed",
    version,
    sha,
    branch,
    why,
    link,
    first,
    ...(via ? { via } : {}),
  };
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

/** The bell item for a pin step: its English text, its key and words, its link. */
export interface PinBell {
  text: string;
  key: string;
  vars: Record<string, string>;
  link: string;
}

/**
 * #176: what the bell says for a pin step (one item, the newest replacing
 * it), or null for a step it doesn't announce. `t` is the product's title.
 * Issue 1189: a pin set to push that went to a pull request says why.
 */
export function pinBellMessage(step: PinStep, t: string): PinBell | null {
  const v = step.version;
  const item = (
    text: string,
    key: string,
    vars: Record<string, string>,
    link = "/server-agent",
  ): PinBell => ({ text, key, vars: { v, ...vars }, link });
  switch (step.did) {
    case "pushed": {
      const sha = step.sha.slice(0, 12);
      return item(
        `${t} updated to ${v}: its pin is committed (${sha}) and pushed`,
        "bell.m.pinPushed",
        { sha },
      );
    }
    case "push_failed": {
      const sha = step.sha.slice(0, 12);
      return item(
        `${t} ${v}: its pin is committed (${sha}) but the push failed: ${step.why}. ${t} tries again at the next update check`,
        "bell.m.pinPushFailed",
        { sha, why: step.why },
      );
    }
    case "commit_failed":
      return item(
        `${t} ${v}: ${t} couldn't commit its pin: ${step.why}. It tries again at the next update check`,
        "bell.m.pinCommitFailed",
        { why: step.why },
      );
    case "pr": {
      if (step.via) {
        const n = pullNumber(step.url) ?? "";
        return item(
          `${t} updated to ${v}: the branch needs a pull request; opened #${n} for its pin (${step.branch})`,
          "bell.m.pinPrFallback",
          { branch: step.branch, n },
          step.url,
        );
      }
      return item(
        `${t} updated to ${v}: its pin is in a pull request (${step.branch})`,
        "bell.m.pinPrOpened",
        { branch: step.branch },
        step.url,
      );
    }
    case "branch_pushed":
      return item(
        `${t} ${v}: the pin branch ${step.branch} is pushed; open a pull request for it (${step.why})`,
        "bell.m.pinBranchPushed",
        { branch: step.branch, why: step.why },
        step.link ?? "/server-agent",
      );
    case "held":
      return item(
        `${t} ${v}: committing its pin waits for your Allow`,
        "bell.m.pinHeld",
        {},
      );
    default:
      return null;
  }
}
