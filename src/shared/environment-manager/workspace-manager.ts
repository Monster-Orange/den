/**
 * Workspace Directory Manager
 *
 * Handles git operations for managed repos:
 *   - .den-services/<repo>/   long-lived branch-tracking clones
 *   - den-workspaces/<ws>/<repo>/  feature workspace clones
 *
 * Dev-managed repos (mode: "dev-managed") are never touched here — the developer
 * owns those checkouts entirely.
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEN_WORKSPACES_DIR, DEN_SERVICES_DIR } from "./workspaces.js";
import { readManifest } from "../manifest/read-manifest.js";
import { readUserConfig } from "../den-config.js";
import {
  spawnInteractive,
  spawnStreaming,
} from "../process/spawn-streaming.js";
import { buildServiceEnv } from "./service-env.js";
import { assertSafeCloneDestination } from "./clone-guard.js";
import type { CommandDef } from "../types/index.js";

// ── Terminal resolution (macOS) ──────────────────────────────────────────────

const KNOWN_TERMINALS: ReadonlyArray<{
  key: string;
  appName: string;
  appPaths: readonly string[];
}> = [
  {
    key: "terminal",
    appName: "Terminal",
    appPaths: ["/System/Applications/Utilities/Terminal.app"],
  },
  { key: "iterm2", appName: "iTerm", appPaths: ["/Applications/iTerm.app"] },
  {
    key: "ghostty",
    appName: "Ghostty",
    appPaths: [
      "/Applications/Ghostty.app",
      path.join(os.homedir(), "Applications/Ghostty.app"),
    ],
  },
  { key: "warp", appName: "Warp", appPaths: ["/Applications/Warp.app"] },
  {
    key: "kitty",
    appName: "kitty",
    appPaths: [
      "/Applications/kitty.app",
      path.join(os.homedir(), "Applications/kitty.app"),
    ],
  },
  {
    key: "alacritty",
    appName: "Alacritty",
    appPaths: [
      "/Applications/Alacritty.app",
      path.join(os.homedir(), "Applications/Alacritty.app"),
    ],
  },
  { key: "hyper", appName: "Hyper", appPaths: ["/Applications/Hyper.app"] },
];

function resolveTerminalAppName(key: string): string | null {
  const terminal = KNOWN_TERMINALS.find((t) => t.key === key);
  if (!terminal) return null;
  for (const p of terminal.appPaths) {
    if (fs.existsSync(p)) return terminal.appName;
  }
  return null;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function git(cmd: string, cwd?: string): void {
  execSync(`git -c credential.helper="!gh auth git-credential" ${cmd}`, {
    cwd,
    stdio: "inherit",
  });
}

function gitCapture(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

/** The HTTPS URL a managed clone of `ghSlug` is made from. */
export function ghCloneUrl(ghSlug: string): string {
  return `https://github.com/${ghSlug}.git`;
}

// ── Injection guards ──────────────────────────────────────────────────────────
//
// git() runs through a shell (execSync), so branch names and GitHub slugs
// interpolated into clone/checkout commands must be validated first. The HTTP
// boundary already checks these (workspace-routes.ts uses the same anchored
// patterns), but CLI callers pass config-sourced values (workspaces.yml,
// service-catalog.yml) straight in — validating here makes workspace-manager
// the single choke point for every clone path.

export const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
export const SAFE_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function assertSafeBranch(branch: string): void {
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(
      `Invalid branch name "${branch}" — only letters, digits, ".", "_", "/" and "-" are allowed`,
    );
  }
}

function assertSafeSlug(ghSlug: string): void {
  if (!SAFE_SLUG_RE.test(ghSlug)) {
    throw new Error(
      `Invalid GitHub slug "${ghSlug}" — expected "owner/repo" using only letters, digits, ".", "_" and "-"`,
    );
  }
}

// ── Post-clone setup ──────────────────────────────────────────────────────────

/**
 * Attempt to run the repo's setup command after a fresh clone.
 *
 * Resolution order:
 *  1. If .den.yml defines commands.local.setup on any service → run that command
 *  2. Else if a Makefile exists at the repo root → run `make setup`
 *
 * Failures are logged as warnings but never thrown — a broken setup
 * should not prevent the workspace from being usable.
 */
/**
 * Resolve the setup command for a repo: the first `setup` command declared in
 * its manifest (entrypoint service first), else `make setup` when a Makefile
 * exists. Returns null when there is nothing to run.
 */
function resolveSetupCommand(repoPath: string): string | null {
  const manifest = readManifest(repoPath);
  if (manifest?.services) {
    const entryKey = manifest.entrypoint;
    const serviceKeys = entryKey
      ? [
          entryKey,
          ...Object.keys(manifest.services).filter((k) => k !== entryKey),
        ]
      : Object.keys(manifest.services);
    for (const key of serviceKeys) {
      const def: CommandDef | undefined =
        manifest.services[key]?.commands?.local?.["setup"];
      if (def) return typeof def === "string" ? def : def.cmd;
    }
  }
  if (fs.existsSync(path.join(repoPath, "Makefile"))) return "make setup";
  return null;
}

/**
 * Environment that lets `make setup` run unattended (mirrors how the web UX runs
 * setup behind a hidden process): skip husky hook-install prompts, make git fail
 * instead of prompting for credentials, and wire `gh` as git's credential helper
 * so in-setup fetches (e.g. common-iac) authenticate without a terminal.
 */
export const NON_INTERACTIVE_SETUP_ENV: NodeJS.ProcessEnv = {
  CI: "1",
  HUSKY: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "!gh auth git-credential",
};

/**
 * Run a repo's setup command non-interactively, streaming output via `onLine`,
 * and resolve to the exit code (0 when there is nothing to set up). Unlike
 * `runSetupIfDefined` this never opens a Terminal window — `den up` uses it so
 * a freshly-cloned managed repo is prepared without ambushing the user with
 * interactive windows.
 */
export interface HiddenSetupResult {
  code: number;
  /**
   * Set when the setup emitted an interactive-looking prompt and then went
   * silent — den killed it. Callers should point the user at running the
   * setup interactively (`den setup <repo>`).
   */
  stalledPrompt?: string;
}

/** Lines that look like a blocking question: `[y/N]`, `(yes/no)`, `password:`. */
const INTERACTIVE_PROMPT_RE =
  /(\[\s*[yY](es)?\s*\/\s*[nN]o?\s*\]|\[\s*[nN]o?\s*\/\s*[yY](es)?\s*\]|\(\s*[yY](es)?\s*\/\s*[nN]o?\s*\)|password\s*:?\s*$|\?\s*$)/;

/** How long a prompt-looking line may sit with no further output before we kill. */
const PROMPT_STALL_MS = 15_000;

export function runSetupHidden(
  repoPath: string,
  onLine: (line: string) => void,
): Promise<HiddenSetupResult> {
  const setupCmd = resolveSetupCommand(repoPath);
  if (!setupCmd) return Promise.resolve({ code: 0 });
  return new Promise<HiddenSetupResult>((resolve) => {
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stalledPrompt: string | undefined;

    // The child runs in its OWN SESSION (detached) so it has no controlling
    // terminal: installers that prompt via /dev/tty (e.g. `curl atlasgo.sh |
    // sh` asking to install a binary) fail that read immediately instead of
    // silently blocking the spinner forever waiting for keystrokes den
    // will never forward.
    const killGroup = (): void => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    };
    // Detached child ⇒ Ctrl+C on den would no longer reach it — reap it
    // ourselves, then exit with the conventional SIGINT status. (Registered
    // AFTER the spawn below so the handler can never observe `proc` in TDZ.)
    const onSigint = (): void => {
      killGroup();
      process.exit(130);
    };

    const clearStall = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    // Defense layers against interactive setups, outermost first:
    //  1. NON_INTERACTIVE_SETUP_ENV (CI/HUSKY/git) — template-guarded prompts
    //     ([ -t 0 ] blocks, husky installs) skip themselves.
    //  2. Detached own-session spawn — /dev/tty prompts fail fast (no
    //     controlling terminal), see killGroup rationale above.
    //  3. `yes n` on stdin — unguarded `read` prompts are DECLINED and the
    //     setup continues, instead of erroring on a failed read. The prompt
    //     text still streams to onLine, so whatever was declined is visible;
    //     "n" is the safe default for a background run.
    //  4. The stall detector below — anything that still blocks is killed and
    //     reported instead of hanging forever.
    const guardedCmd = `yes n 2>/dev/null | ( ${setupCmd} )`;
    const proc = spawnStreaming(
      guardedCmd,
      [],
      { ...process.env, ...buildServiceEnv(), ...NON_INTERACTIVE_SETUP_ENV },
      (line) => {
        // Insurance for tools that still manage to block: a prompt-looking
        // line followed by silence means nobody can ever answer — kill and
        // report instead of hanging the whole `up`.
        clearStall();
        if (INTERACTIVE_PROMPT_RE.test(line.trim())) {
          const prompt = line.trim();
          stallTimer = setTimeout(() => {
            stalledPrompt = prompt;
            killGroup();
          }, PROMPT_STALL_MS);
        }
        onLine(line);
      },
      (code) => {
        clearStall();
        process.removeListener("SIGINT", onSigint);
        resolve({
          code: stalledPrompt && code === 0 ? 1 : code,
          stalledPrompt,
        });
      },
      repoPath,
      true, // own session — see killGroup/tty rationale above
    );
    process.once("SIGINT", onSigint);
  });
}

/**
 * Re-run a repo's setup in THE CURRENT terminal (inherited stdio) so the user
 * can answer the prompt a hidden setup stalled on. Deliberately omits
 * NON_INTERACTIVE_SETUP_ENV (CI=1, GIT_TERMINAL_PROMPT=0) — prompting the
 * user is the point. Resolves to the exit code (0 when the repo declares no
 * setup command).
 */
export function runSetupInteractive(repoPath: string): Promise<number> {
  const setupCmd = resolveSetupCommand(repoPath);
  if (!setupCmd) return Promise.resolve(0);
  return new Promise<number>((resolve) => {
    spawnInteractive(
      setupCmd,
      { ...process.env, ...buildServiceEnv() },
      resolve,
      repoPath,
    );
  });
}

/**
 * Den records a per-clone marker once setup has completed successfully, so
 * `den up` can tell a fully-prepared clone from one that was cloned but whose
 * setup failed (or never ran) — and re-run setup instead of starting a
 * half-prepared repo. The marker lives BESIDE the clone dir (not inside the
 * repo) so it never shows up as a dirty working-tree file.
 */
export function setupMarkerPath(repoPath: string): string {
  return path.join(
    path.dirname(repoPath),
    `.${path.basename(repoPath)}.setup-ok`,
  );
}

export function hasSetupSucceeded(repoPath: string): boolean {
  return fs.existsSync(setupMarkerPath(repoPath));
}

export function markSetupSucceeded(repoPath: string): void {
  try {
    fs.writeFileSync(
      setupMarkerPath(repoPath),
      `${new Date().toISOString()}\n`,
    );
  } catch {
    /* the marker is an optimization — ignore write failures */
  }
}

/** Whether the repo actually has a setup command to run (else nothing to do). */
export function hasSetupCommand(repoPath: string): boolean {
  return resolveSetupCommand(repoPath) !== null;
}

function runSetupIfDefined(repoPath: string): void {
  try {
    const setupCmd = resolveSetupCommand(repoPath);
    if (!setupCmd) return;

    const repoName = path.basename(repoPath);
    console.log(`  ⚙ Opening terminal for setup in ${repoName}: ${setupCmd}`);

    // Write a .command script so macOS opens it in a terminal window,
    // allowing the user to interact (enter tokens, passwords, etc.).
    const safePath = repoPath.replace(/'/g, "'\\''");
    const tmp = path.join(
      os.tmpdir(),
      `${product().cli}-setup-${repoName}-${Date.now()}.command`,
    );
    // A .command opens a fresh login shell that does NOT inherit den's env, so
    // export the den-resolved shared env (the org config's service_env) into it too.
    const exportLines = Object.entries(buildServiceEnv()).map(
      ([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`,
    );
    fs.writeFileSync(
      tmp,
      [
        "#!/bin/bash",
        `echo "${product().title} — running setup for ${repoName}"`,
        `echo "  ${setupCmd}"`,
        `echo ""`,
        ...exportLines,
        `cd '${safePath}'`,
        setupCmd,
        `EXIT_CODE=$?`,
        `echo ""`,
        `if [ $EXIT_CODE -eq 0 ]; then echo "✓ Setup complete."; else echo "✗ Setup failed (exit $EXIT_CODE)."; fi`,
        `echo "Press enter to close this window."`,
        `read`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Use the user's preferred terminal if configured, otherwise the OS default.
    const userTerminal = readUserConfig().terminal;
    const appName = userTerminal ? resolveTerminalAppName(userTerminal) : null;
    const openArgs = appName ? ["-a", appName, tmp] : [tmp];
    spawnSync("open", openArgs, { timeout: 5_000 });

    // Best-effort cleanup after the terminal has had time to read the file.
    // unref() so this fire-and-forget timer never keeps the process (or a
    // jest worker) alive — otherwise it pins the event loop for 5s as an
    // open handle and hangs CI test runs (jest waits on workers to exit).
    const cleanupTimer = setTimeout(() => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }, 5_000);
    cleanupTimer.unref();
  } catch (err) {
    console.warn(
      `  ⚠ Setup failed for ${path.basename(repoPath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Managed service clones (.den-services/) ────────────────────────────────

/**
 * Ensure a managed service clone exists at .den-services/<repoName>/<branch>/.
 * Different branches of the same repo live side-by-side and are shared across workspaces.
 * Clones from GitHub if missing; fast-forwards if already present.
 * Returns the absolute clone path.
 */
export function ensureManagedServiceClone(
  repoName: string,
  ghSlug: string,
  branch = "main",
  /**
   * Run the interactive (Terminal-window) setup after a first clone. Default
   * true preserves the register/web behavior; `den up` passes false and runs
   * setup itself via the hidden, non-interactive `runSetupHidden`.
   */
  runSetup = true,
): string {
  assertSafeSlug(ghSlug);
  assertSafeBranch(branch);
  const cloneDir = path.join(DEN_SERVICES_DIR, repoName, branch);

  if (!fs.existsSync(cloneDir)) {
    assertSafeCloneDestination(cloneDir, repoName);
    console.log(
      `  ⬇ Cloning ${ghSlug}@${branch} → ${product().servicesDir}/${repoName}/${branch}/`,
    );
    fs.mkdirSync(path.join(DEN_SERVICES_DIR, repoName), {
      recursive: true,
    });
    git(
      `clone --filter=blob:none --branch "${branch}" "${ghCloneUrl(ghSlug)}" "${cloneDir}"`,
    );
    if (runSetup) runSetupIfDefined(cloneDir);
  } else {
    git("pull --ff-only", cloneDir);
  }

  return cloneDir;
}

/**
 * Clone a managed repo from a base branch, then create a new local
 * branch on top of it. The clone lives at `.den-services/<repoName>/<newBranch>/`
 * so managed branch tracking works correctly.
 *
 * Returns the absolute path to the clone directory.
 */
export function ensureManagedServiceCloneNewBranch(
  repoName: string,
  ghSlug: string,
  baseBranch: string,
  newBranch: string,
): string {
  assertSafeSlug(ghSlug);
  assertSafeBranch(baseBranch);
  assertSafeBranch(newBranch);
  const cloneDir = path.join(DEN_SERVICES_DIR, repoName, newBranch);
  if (!fs.existsSync(cloneDir)) {
    assertSafeCloneDestination(cloneDir, repoName);
    console.log(
      `  ⬇ Cloning ${ghSlug}@${baseBranch} → ${product().servicesDir}/${repoName}/${newBranch}/ (new branch: ${newBranch})`,
    );
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    git(
      `clone --filter=blob:none --branch "${baseBranch}" "${ghCloneUrl(ghSlug)}" "${cloneDir}"`,
    );
    git(`checkout -b "${newBranch}"`, cloneDir);
    runSetupIfDefined(cloneDir);
  }
  return cloneDir;
}

// ── Dev-managed clones (repos_root/<workspace>/<repo>/) ──────────────────────

/**
 * Clone a GitHub repo to the given absolute targetDir so the developer
 * can manage it directly (dev-managed mode).
 *
 * The checkout is a normal git clone — den does NOT auto-pull or manage
 * the branch after the initial clone. The developer owns it.
 *
 * Returns the absolute path to the clone directory.
 */
export function ensureDevManagedClone(
  targetDir: string,
  ghSlug: string,
  branch: string,
): string {
  assertSafeSlug(ghSlug);
  assertSafeBranch(branch);
  if (!fs.existsSync(targetDir)) {
    const leafName = path.basename(targetDir);
    assertSafeCloneDestination(targetDir, leafName);
    console.log(`  ⬇ Cloning ${ghSlug}@${branch} → ${targetDir}/`);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
      git(
        `clone --filter=blob:none --branch "${branch}" "${ghCloneUrl(ghSlug)}" "${targetDir}"`,
      );
    } catch {
      // Branch may not exist — clone default branch and checkout/create the branch
      git(`clone --filter=blob:none "${ghCloneUrl(ghSlug)}" "${targetDir}"`);
      try {
        git(`checkout "${branch}"`, targetDir);
      } catch {
        git(`checkout -b "${branch}"`, targetDir);
        console.log(`  ✓ Created new branch ${branch} in ${leafName}`);
      }
    }
    runSetupIfDefined(targetDir);
  }
  return targetDir;
}

// ── Feature workspace clones (den-workspaces/) ───────────────────────────

/**
 * Ensure a feature workspace clone exists at den-workspaces/<ws>/<repo>/.
 * Creates the branch if it doesn't exist on the remote (branching from main).
 * Returns the absolute clone path.
 */
export function ensureWorkspaceClone(
  workspaceName: string,
  repoName: string,
  ghSlug: string,
  branch: string,
): string {
  assertSafeSlug(ghSlug);
  assertSafeBranch(branch);
  const wsDir = path.join(DEN_WORKSPACES_DIR, workspaceName);
  const cloneDir = path.join(wsDir, repoName);

  if (!fs.existsSync(cloneDir)) {
    assertSafeCloneDestination(cloneDir, repoName);
    console.log(
      `  ⬇ Cloning ${ghSlug}@${branch} → ${product().workspacesDir}/${workspaceName}/${repoName}/`,
    );
    fs.mkdirSync(wsDir, { recursive: true });

    try {
      git(
        `clone --filter=blob:none --branch "${branch}" "${ghCloneUrl(ghSlug)}" "${cloneDir}"`,
      );
    } catch {
      // Branch doesn't exist yet — clone main and create the branch
      git(`clone --filter=blob:none "${ghCloneUrl(ghSlug)}" "${cloneDir}"`);
      git(`checkout -b "${branch}"`, cloneDir);
      console.log(`  ✓ Created new branch ${branch} in ${repoName}`);
    }
    runSetupIfDefined(cloneDir);
  }

  return cloneDir;
}

/**
 * Delete the workspace directory at den-workspaces/<workspaceName>/.
 * Warns (but does not block) if repos inside have unpushed commits.
 */
export function deleteWorkspaceDirectory(workspaceName: string): void {
  const wsDir = path.join(DEN_WORKSPACES_DIR, workspaceName);
  if (!fs.existsSync(wsDir)) return;

  // Warn about unpushed commits in any clones
  for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoDir = path.join(wsDir, entry.name);
    try {
      const unpushed = gitCapture(
        "git log --oneline @{u}..HEAD 2>/dev/null | wc -l",
        repoDir,
      );
      if (parseInt(unpushed, 10) > 0) {
        console.warn(
          `  ⚠ ${entry.name} has unpushed commits — push before deleting`,
        );
      }
    } catch {
      // No upstream set or not a git repo — skip
    }
  }

  fs.rmSync(wsDir, { recursive: true, force: true });
}

/**
 * Rename the on-disk workspace directory from oldName to newName.
 *
 * - If den-workspaces/<newName> already exists it is moved aside to
 *   den-workspaces/<newName>-backup-<timestamp> (no data loss).
 * - The <oldName>.code-workspace file inside the directory is renamed to
 *   <newName>.code-workspace so VS Code picks it up correctly.
 *
 * Returns the new absolute directory path, or null if the old directory
 * did not exist (nothing to rename).
 */
export function renameWorkspaceDirectory(
  oldDir: string,
  newName: string,
): string | null {
  if (!fs.existsSync(oldDir)) return null;

  const oldName = path.basename(oldDir);
  const newDir = path.join(DEN_WORKSPACES_DIR, newName);

  if (fs.existsSync(newDir)) {
    const backupDir = path.join(
      DEN_WORKSPACES_DIR,
      `${newName}-backup-${Date.now()}`,
    );
    fs.renameSync(newDir, backupDir);
  }

  fs.mkdirSync(DEN_WORKSPACES_DIR, { recursive: true });
  fs.renameSync(oldDir, newDir);

  const oldCodeWs = path.join(newDir, `${oldName}.code-workspace`);
  const newCodeWs = path.join(newDir, `${newName}.code-workspace`);
  if (fs.existsSync(oldCodeWs)) {
    fs.renameSync(oldCodeWs, newCodeWs);
  }

  return newDir;
}

// ── Sync helpers ──────────────────────────────────────────────────────────────

/**
 * Return how many commits the local repo is behind its upstream.
 * Returns -1 if the check fails (e.g. no upstream configured).
 */
export function checkBehindCount(repoPath: string): number {
  try {
    gitCapture("git fetch --quiet", repoPath);
    const behind = gitCapture("git rev-list --count HEAD..@{u}", repoPath);
    return parseInt(behind, 10);
  } catch {
    return -1;
  }
}

/**
 * Pull the latest commits (fast-forward only) in a MANAGED clone.
 * (Sole caller is `den sync`, which skips dev-managed checkouts.)
 *
 * Discards local tracked changes first: `make up`/`setup` codegen dirties
 * managed clones (the OpenAPI generator datestamps gen/openapi/README.md,
 * regenerates internal/apis/deps.go, …), and a dirty tree makes the ff-only
 * pull abort with "your local changes would be overwritten". Nothing in a
 * managed clone is worth preserving — den owns it.
 */
export function pullRepo(repoPath: string): void {
  try {
    git("restore .", repoPath);
  } catch {
    /* best-effort — a genuinely diverged clone still errors on the pull */
  }
  git("pull --ff-only", repoPath);
}

/**
 * Fetch (with gh credentials, so private repos authenticate) and fast-forward a
 * managed clone, synchronously, returning a structured result. CLI-only —
 * execSync blocks the event loop, so never call this from the web server (use
 * the async `syncManagedClone` there). Fast-forward-only never clobbers local
 * work; a diverged clone surfaces as an error instead of a silent overwrite.
 *
 *   behind -1            : no upstream configured, or the fetch failed
 *                          (network unreachable / auth) — caller should skip.
 *   behind  0            : already current.
 *   behind >0, pulled    : fast-forwarded that many commits.
 *   behind >0, !pulled   : diverged or local changes blocked the fast-forward
 *                          (error populated); the clone is left untouched.
 */
export function fetchAndFastForward(repoPath: string): {
  behind: number;
  pulled: boolean;
  error?: string;
} {
  const GH_CRED = `-c credential.helper="!gh auth git-credential"`;
  try {
    execSync(`git ${GH_CRED} fetch --quiet`, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { behind: -1, pulled: false, error: (e as Error).message };
  }
  let behind: number;
  try {
    // Local comparison against the just-fetched upstream — no network/creds.
    behind = parseInt(
      gitCapture("git rev-list --count HEAD..@{u}", repoPath),
      10,
    );
  } catch {
    return { behind: -1, pulled: false }; // no upstream tracking ref
  }
  if (Number.isNaN(behind)) return { behind: -1, pulled: false };
  if (behind === 0) return { behind: 0, pulled: false };
  try {
    // Managed clones accumulate `make up`/`setup` codegen (datestamped
    // gen/openapi/README.md etc.) — discard it so the ff merge isn't blocked
    // by a dirty tree. Nothing in a managed clone is worth preserving.
    execSync("git restore .", {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort */
  }
  try {
    execSync(`git ${GH_CRED} merge --ff-only @{u}`, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { behind, pulled: true };
  } catch (e) {
    return { behind, pulled: false, error: (e as Error).message };
  }
}

// ── Async git helpers (don't block the event loop) ───────────────────────────
//
// The synchronous `git` / `gitCapture` above use execSync, which pauses
// Node.js for the full duration of the command. That's fine for CLI paths
// but catastrophic inside HTTP request handlers: a single `git fetch` over
// VPN can freeze the whole server for 10+ seconds. Use these async variants
// anywhere a git call runs inside the server event loop (e.g. workspace
// sync SSE handler).

import { spawn } from "child_process";

import { product } from "../product.js";
function runGitAsync(
  args: string[],
  cwd: string | undefined,
  isCancelled: (() => boolean) | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Poll the cancellation flag; kill the git process if it flips.
    const cancelTimer = isCancelled
      ? setInterval(() => {
          if (isCancelled()) {
            if (cancelTimer) clearInterval(cancelTimer);
            try {
              proc.kill();
            } catch {
              /* already exited */
            }
          }
        }, 500)
      : null;
    proc.on("close", (code) => {
      if (cancelTimer) clearInterval(cancelTimer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    proc.on("error", (err) => {
      if (cancelTimer) clearInterval(cancelTimer);
      reject(err);
    });
  });
}

/**
 * Fetch + check behind + fast-forward in a single async call. Replaces the
 * three synchronous git calls that blocked the event loop during workspace
 * sync (checkBehindCount's `git fetch` + `git rev-list`, then
 * ensureManagedServiceClone's `git pull`).
 *
 * `isCancelled` is polled between ops so the SSE handler can abort cleanly
 * when the client disconnects mid-sync.
 */
export interface SyncResult {
  /** -1: no upstream / unreachable. 0: already up to date. >0: commits pulled. */
  behind: number;
  /** True when a pull actually happened (behind > 0 and ff succeeded). */
  pulled: boolean;
  /** Populated on pull failure; empty on success. */
  error?: string;
  /** True if we bailed out early because isCancelled() returned true. */
  cancelled?: boolean;
}

/**
 * Read-only half of a sync: fetch and count how far the clone is behind its
 * upstream. Split out from syncManagedClone so the workspace sync can decide
 * whether a (disruptive) down → pull → setup chain is warranted BEFORE
 * touching a running service — a sync with nothing to pull must not stop it.
 */
export async function checkManagedCloneBehind(
  repoPath: string,
  isCancelled?: () => boolean,
): Promise<{ behind: number; cancelled?: boolean }> {
  // 1. fetch
  try {
    const { code } = await runGitAsync(
      ["fetch", "--quiet"],
      repoPath,
      isCancelled,
    );
    if (isCancelled?.()) {
      return { behind: 0, cancelled: true };
    }
    if (code !== 0) return { behind: -1 };
  } catch {
    return { behind: -1 };
  }

  // 2. count-behind
  try {
    const { stdout, code } = await runGitAsync(
      ["rev-list", "--count", "HEAD..@{u}"],
      repoPath,
      isCancelled,
    );
    if (isCancelled?.()) {
      return { behind: 0, cancelled: true };
    }
    if (code !== 0) return { behind: -1 };
    const behind = parseInt(stdout.trim(), 10);
    if (Number.isNaN(behind)) return { behind: -1 };
    return { behind };
  } catch {
    return { behind: -1 };
  }
}

/**
 * Mutating half of a sync: discard local noise and fast-forward. Callers have
 * already established `behind > 0` via checkManagedCloneBehind (a second fetch
 * here would just double the network round-trips).
 */
export async function pullManagedClone(
  repoPath: string,
  behind: number,
  isCancelled?: () => boolean,
): Promise<SyncResult> {
  // 2.5 discard local changes. Managed clones accumulate uncommitted codegen
  // from `make setup` (e.g. gen/openapi/README.md, internal/apis/deps.go); the
  // tree is behind but NOT diverged, so `git pull --ff-only` would abort on the
  // dirty tree. There's nothing to preserve in a managed clone, so reset
  // tracked changes before pulling. (Best-effort — a real failure surfaces below.)
  try {
    await runGitAsync(["restore", "."], repoPath, isCancelled);
    if (isCancelled?.()) {
      return { behind, pulled: false, cancelled: true };
    }
  } catch {
    /* best-effort */
  }

  // 3. fast-forward pull
  try {
    const { code, stderr } = await runGitAsync(
      ["pull", "--ff-only"],
      repoPath,
      isCancelled,
    );
    if (isCancelled?.()) {
      return { behind, pulled: false, cancelled: true };
    }
    if (code !== 0) {
      const detail = stderr.trim();
      return {
        behind,
        pulled: false,
        error: detail ? `pull failed: ${detail}` : `pull exited ${code}`,
      };
    }
    return { behind, pulled: true };
  } catch (e) {
    return { behind, pulled: false, error: (e as Error).message };
  }
}

/** fetch → count → pull as one call, for callers with nothing to do between
 * the check and the pull. Composition of the two halves above. */
export async function syncManagedClone(
  repoPath: string,
  isCancelled?: () => boolean,
): Promise<SyncResult> {
  const chk = await checkManagedCloneBehind(repoPath, isCancelled);
  if (chk.cancelled) {
    return { behind: chk.behind, pulled: false, cancelled: true };
  }
  if (chk.behind <= 0) return { behind: chk.behind, pulled: false };
  return pullManagedClone(repoPath, chk.behind, isCancelled);
}
