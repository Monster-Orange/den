/**
 * ON-3's read actions, as data: what the MCP tools `onboard_status`,
 * `repos_detect` and `manifest_draft` answer, what the web server's
 * /api/onboard/* routes serve, and what their CLI twins print
 * (`onboard status`, `repo detect`, `repo add --dry-run`). One copy, so a
 * person, the browser and an agent get the same answer.
 *
 * All three only read. Nothing here writes a file, runs a repo's tools, or
 * follows a symlink while scanning.
 *
 * **The path rule** (checkOnboardPath), for `repos_detect` and
 * `manifest_draft`: a path is required, absolute (or `~/…`), resolved with
 * its symlinks, and must be a folder inside the person's home folder and
 * outside Den's own state folder. Anything else is refused with the reason.
 *
 * **The scan** (reposDetect): the folder itself when it is a git repo (it
 * has `.git`), else its subfolders one and two levels down. A repo's own
 * subfolders are not scanned. Skipped: symlinks (never followed), dot-folders,
 * node_modules and vendor. At most `maxRepos` repos (default 50) and
 * MAX_ENTRIES folder entries are read; past either, `truncated` is true.
 *
 * **Suggested workspaces:** the repos in one parent folder go in one
 * workspace named after that folder. A repo directly in the scanned folder
 * gets the scanned folder's name; `<folder>/<group>/<repo>` gets `<group>`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import {
  heldManifestPath,
  repoManifestPath,
} from "../../shared/manifest/read-manifest.js";
import {
  MCP_CLIENTS,
  RUNTIME_CLIENTS,
  tomlHasEntry,
  type ConnectEnv,
  type ServerSpec,
} from "../mcp/connect.js";
import {
  onboardingChecks,
  type OnboardCheck,
  type OnboardDeps,
} from "./doctor-onboard.js";
import { detectRunCommands, type DetectedCommands } from "./repo-detect.js";
import {
  repoAdd,
  type ManifestValidator,
  type RepoAddResult,
} from "./repo-command.js";

// ── The path rule ───────────────────────────────────────────────────────────

export interface PathRules {
  /** The person's home folder. */
  home: string;
  /** Den's own state folder (getStateDir()): never scanned. */
  stateDir: string;
}

export type PathCheck =
  | { ok: true; dir: string }
  | { ok: false; error: string };

/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The folder `p` names, when the path rule allows it (see the module comment). */
export function checkOnboardPath(
  p: string | undefined,
  rules: PathRules,
): PathCheck {
  const given = (p ?? "").trim();
  if (!given)
    return {
      ok: false,
      error: "give a folder: path is required (for example ~/code)",
    };
  const expanded =
    given === "~"
      ? rules.home
      : given.startsWith("~/")
        ? path.join(rules.home, given.slice(2))
        : given;
  if (!path.isAbsolute(expanded))
    return {
      ok: false,
      error: `give an absolute path (or one starting with ~/), not "${given}"`,
    };
  let dir: string;
  try {
    dir = fs.realpathSync(expanded);
  } catch {
    return { ok: false, error: `there is no folder at ${expanded}` };
  }
  if (!fs.statSync(dir).isDirectory())
    return { ok: false, error: `${expanded} is a file, not a folder` };
  const home = real(rules.home);
  if (!within(dir, home))
    return {
      ok: false,
      error: `${expanded} is outside your home folder (${home}); Den only reads folders inside it`,
    };
  if (within(dir, real(rules.stateDir)))
    return {
      ok: false,
      error: `${expanded} is in Den's own state folder; Den doesn't scan it`,
    };
  return { ok: true, dir };
}

/** The rules for this process: its home and Den's state folder. */
export function processPathRules(stateDir: string): PathRules {
  return { home: os.homedir(), stateDir };
}

// ── repos_detect ────────────────────────────────────────────────────────────

/** Folder names never scanned (besides every dot-folder). */
export const SKIP_DIRS: readonly string[] = ["node_modules", "vendor"];
/** Default and ceiling for how many repos one scan reports. */
export const MAX_REPOS = 50;
/** How many folder entries one scan reads, at most. */
export const MAX_ENTRIES = 5000;

export const WORKSPACE_RULE =
  "The repos in one parent folder go in one project named after that folder; " +
  "a repo directly in the scanned folder gets the scanned folder's name.";

/** A repo already in a workspace (a dev-managed entry's path). */
export interface RegisteredRepo {
  path: string;
  workspace: string;
  repo: string;
}

export interface DetectedRepo {
  name: string;
  path: string;
  /** 0: the scanned folder itself; 1 or 2: how far down. */
  depth: number;
  /** Where its manifest comes from: its own, a side-car Den holds, or none yet. */
  manifest: "repo" | "sidecar" | "none";
  /** With no manifest: how it runs, when detection decided. */
  runs?: Omit<DetectedCommands, "composeFile"> & { composeFile?: string };
  /** With no manifest and no single answer: the question and the choices. */
  ask?: string;
  choices?: string[];
  /** The workspace suggested for it. */
  workspace: string;
  /** The workspaces it is already in. */
  registered?: { workspace: string; repo: string }[];
}

export type ReposDetectResult =
  | {
      ok: true;
      path: string;
      repos: DetectedRepo[];
      workspaces: { name: string; repos: string[] }[];
      truncated: boolean;
      skipped: { symlinks: number; folders: number };
      rule: string;
      next: string[];
    }
  | { ok: false; error: string };

/** A folder name as a workspace name: other characters become "-". */
export function workspaceNameFrom(folder: string): string {
  const name = folder
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return WORKSPACE_NAME_RE.test(name) ? name : "default";
}

function isRepo(dir: string): boolean {
  try {
    // A worktree's `.git` is a file; a symlinked `.git` is not trusted.
    const st = fs.lstatSync(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function describeRepo(
  dir: string,
  depth: number,
  workspace: string,
  registered: RegisteredRepo[],
): DetectedRepo {
  const out: DetectedRepo = {
    name: path.basename(dir),
    path: dir,
    depth,
    manifest: repoManifestPath(dir)
      ? "repo"
      : heldManifestPath(dir)
        ? "sidecar"
        : "none",
    workspace,
  };
  if (out.manifest === "none") {
    const d = detectRunCommands(dir);
    if (d.decided) out.runs = d.commands;
    else {
      out.ask = d.ask;
      out.choices = d.choices;
    }
  }
  const mine = registered.filter((r) => path.resolve(r.path) === dir);
  if (mine.length)
    out.registered = mine.map((r) => ({
      workspace: r.workspace,
      repo: r.repo,
    }));
  return out;
}

/** The git repos in `p` (see the module comment). Reads only. */
export function reposDetect(
  p: string | undefined,
  rules: PathRules,
  opts: {
    maxRepos?: number;
    registered?: () => RegisteredRepo[];
    bin?: string;
  } = {},
): ReposDetectResult {
  const check = checkOnboardPath(p, rules);
  if (!check.ok) return check;
  const root = check.dir;
  const max = Math.max(1, Math.min(opts.maxRepos ?? MAX_REPOS, MAX_REPOS));
  const registered = opts.registered?.() ?? [];
  const stateDir = real(rules.stateDir);
  const rootName = workspaceNameFrom(path.basename(root));
  const repos: DetectedRepo[] = [];
  const skipped = { symlinks: 0, folders: 0 };
  let entries = 0;
  let truncated = false;

  /** The subfolders worth looking in, never through a symlink. */
  const subdirs = (dir: string): string[] => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (e.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (!e.isDirectory()) continue;
      const abs = path.join(dir, e.name);
      if (
        e.name.startsWith(".") ||
        SKIP_DIRS.includes(e.name) ||
        within(abs, stateDir)
      ) {
        skipped.folders++;
        continue;
      }
      out.push(abs);
    }
    return out;
  };

  const add = (dir: string, depth: number, workspace: string): boolean => {
    if (repos.length >= max) {
      truncated = true;
      return false;
    }
    repos.push(describeRepo(dir, depth, workspace, registered));
    return true;
  };

  if (isRepo(root)) add(root, 0, rootName);
  else
    outer: for (const one of subdirs(root)) {
      if (isRepo(one)) {
        if (!add(one, 1, rootName)) break;
        continue;
      }
      const group = workspaceNameFrom(path.basename(one));
      for (const two of subdirs(one))
        if (isRepo(two) && !add(two, 2, group)) break outer;
      if (truncated) break;
    }

  const groups = new Map<string, string[]>();
  for (const r of repos)
    groups.set(r.workspace, [...(groups.get(r.workspace) ?? []), r.name]);
  const bin = opts.bin ?? "den";
  return {
    ok: true,
    path: root,
    repos,
    workspaces: [...groups].map(([name, names]) => ({ name, repos: names })),
    truncated,
    skipped,
    rule: WORKSPACE_RULE,
    next: repos.length
      ? [`${bin} repo add ${repos[0].path} --dry-run --json`]
      : [],
  };
}

// ── manifest_draft ──────────────────────────────────────────────────────────

/**
 * The side-car manifest `repo add` would write for the repo at `p`, checked
 * by the same validator, and nothing written (`repo add --dry-run`).
 */
export function manifestDraft(
  p: string | undefined,
  rules: PathRules,
  validate: ManifestValidator,
  opts: { name?: string; run?: string; down?: string; health?: string } = {},
): RepoAddResult {
  const check = checkOnboardPath(p, rules);
  if (!check.ok) return { ok: false, dryRun: true, error: check.error };
  return repoAdd(
    {
      spec: check.dir,
      sidecar: false,
      json: true,
      dryRun: true,
      ...opts,
    },
    validate,
    check.dir,
  );
}

// ── onboard_status ──────────────────────────────────────────────────────────

export type StepStatus = "ok" | "warn" | "todo";

export interface StatusCheck {
  id: string;
  status: StepStatus;
  detail: string;
  fix?: string;
  ask?: string;
  url?: string;
}

export interface McpRegistrationEnv {
  cli: string;
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  /** The distribution's folder: a project-scope config there counts. */
  projectDir: string;
  which: (bin: string) => boolean;
  read: (file: string) => string | null;
  /** The request came through Den's own MCP server. */
  viaMcp?: boolean;
}

/**
 * Whether an agent has Den's MCP: asked through it, or a client's config
 * file names this distribution's server. A client Den registers by running
 * its own CLI (Claude Code, Codex) is never run to check: that is a warning
 * pointing at `<cli> mcp clients`, not a guess.
 */
export function mcpRegistration(e: McpRegistrationEnv): StatusCheck {
  const fixFor = (runtime: string) =>
    `${e.cli} mcp connect --runtime ${runtime} --json`;
  if (e.viaMcp)
    return {
      id: "mcp",
      status: "ok",
      detail: "connected: this question came through Den's MCP",
    };
  const spec: ServerSpec = { name: e.cli, command: "", args: [], env: {} };
  const env: ConnectEnv = {
    home: e.home,
    platform: e.platform,
    appData: e.appData,
    projectDir: e.projectDir,
    which: e.which,
    exists: () => false,
  };
  const found: string[] = [];
  const unchecked: string[] = [];
  for (const c of MCP_CLIENTS)
    for (const scope of c.scopes) {
      const a = c.plan(spec, scope, env);
      if (a.kind === "exec") {
        if (scope === "user" && e.which(a.add[0])) unchecked.push(c.id);
        continue;
      }
      const text = e.read(a.file);
      if (!text) continue;
      const has =
        a.kind === "json"
          ? (() => {
              try {
                const doc = JSON.parse(text) as Record<
                  string,
                  Record<string, unknown>
                >;
                return doc?.[a.key]?.[a.name] !== undefined;
              } catch {
                return false;
              }
            })()
          : tomlHasEntry(text, a.name, a.entry) !== "absent";
      if (has && !found.includes(c.title)) found.push(c.title);
    }
  if (found.length)
    return {
      id: "mcp",
      status: "ok",
      detail: `connected: ${found.join(", ")} ${found.length === 1 ? "has" : "have"} Den's MCP`,
    };
  const runtimeOf = (id: string) =>
    Object.entries(RUNTIME_CLIENTS).find(([, c]) => c === id)?.[0];
  if (unchecked.length) {
    const titles = unchecked.map(
      (id) => MCP_CLIENTS.find((c) => c.id === id)?.title ?? id,
    );
    return {
      id: "mcp",
      status: "warn",
      detail: `${titles.join(" and ")} ${titles.length === 1 ? "is" : "are"} installed; Den can't tell whether ${titles.length === 1 ? "it has" : "they have"} Den's MCP without running ${titles.length === 1 ? "it" : "them"}. \`${e.cli} mcp clients\` shows it`,
      fix: fixFor(runtimeOf(unchecked[0]) ?? "claude"),
    };
  }
  return {
    id: "mcp",
    status: "todo",
    detail: "no agent has Den's MCP yet",
    fix: fixFor(`<${Object.keys(RUNTIME_CLIENTS).join("|")}>`),
  };
}

export interface OnboardStatusDeps {
  /** The command a person runs, e.g. `./bin/acme`. */
  bin: string;
  /** This is a distribution (it has its bin/<cli> shim), not Den's own folder. */
  distribution: boolean;
  /** doctor's ON-2 probes: node, git, docker and the web server. */
  doctor: OnboardDeps;
  /** Workspace names, the active ones, and every registered repo's name. */
  workspaces: () => { names: string[]; active: string[]; repos: string[] };
  /** The services Den started that are running (addresses). */
  running: () => string[];
  /** Whether an agent has Den's MCP (mcpRegistration). */
  mcp: () => StatusCheck;
}

export interface OnboardStatus {
  ok: boolean;
  checks: StatusCheck[];
  /** The one next step, in plain words, with its command. */
  next: { id: string; step: string; command?: string };
}

const fromDoctor = (c: OnboardCheck): StatusCheck => ({
  id: c.id,
  status: c.status === "fail" ? "todo" : c.status,
  detail: c.detail,
  ...(c.fix ? { fix: c.fix } : {}),
  ...(c.ask ? { ask: c.ask } : {}),
  ...(c.url ? { url: c.url } : {}),
});

/** The next step for each check that isn't ok, in plain words. */
const STEPS: Record<string, string> = {
  distribution:
    "Create your own Den first: it gets its own folder, name and command.",
  node: "Install a newer Node: Den needs 22.13 or later.",
  git: "Install git.",
  docker: "Start Docker: some of your repos run in containers.",
  web: "Start the web server.",
  workspaces: "Turn on a project, so Den runs its services.",
  repos: "Add your first repo. Den can find the repos in a folder for you.",
  service: "Start one service.",
  mcp: "Connect your agent to Den's MCP, so it can see and run your services.",
};

/** What is set up, and the one next step (see the module comment). */
export async function onboardStatus(
  d: OnboardStatusDeps,
): Promise<OnboardStatus> {
  // doctor's own MCP check runs `<cli> mcp --call`, a child process that
  // asks the web server back; the status reads config instead (d.mcp).
  const doctor = (
    await onboardingChecks({ ...d.doctor, mcpCall: () => ({ ok: true }) })
  )
    // mcp:approvals is doctor's; the status's own mcp check is d.mcp.
    .filter((c) => c.id !== "mcp" && c.id !== "mcp:approvals")
    .map(fromDoctor);
  const ws = d.workspaces();
  const running = d.running();
  const webOk = doctor.find((c) => c.id === "web")?.status === "ok";
  const checks: StatusCheck[] = [
    d.distribution
      ? {
          id: "distribution",
          status: "ok",
          detail: "this is a distribution of its own",
        }
      : {
          id: "distribution",
          status: "warn",
          detail: "this is Den's own folder, not a distribution",
          fix: "den create <name> --yes --json",
        },
    ...doctor,
    ws.names.length === 0
      ? {
          id: "workspaces",
          status: "todo",
          detail:
            "no projects yet (adding the first repo makes one named default)",
          fix: `${d.bin} repo add <folder> --json`,
        }
      : ws.active.length === 0
        ? {
            id: "workspaces",
            status: "warn",
            detail: `${ws.names.length} project${ws.names.length === 1 ? "" : "s"}, none active`,
            fix: `${d.bin} workspace activate ${ws.names[0]}`,
          }
        : {
            id: "workspaces",
            status: "ok",
            detail: `${ws.names.length} project${ws.names.length === 1 ? "" : "s"}, ${ws.active.length} active (${ws.active.join(", ")})`,
          },
    ws.repos.length === 0
      ? {
          id: "repos",
          status: "todo",
          detail: "no repos added yet",
          fix: `${d.bin} repo detect <folder> --json`,
        }
      : {
          id: "repos",
          status: "ok",
          detail: `${ws.repos.length} repo${ws.repos.length === 1 ? "" : "s"} added`,
        },
    running.length
      ? {
          id: "service",
          status: "ok",
          detail: `${running.length} service${running.length === 1 ? "" : "s"} running`,
        }
      : {
          id: "service",
          status: "todo",
          detail: "no service Den started is running",
          fix: ws.repos.length
            ? `${d.bin} up ${ws.repos[0]} --json`
            : `${d.bin} up <repo> --json`,
        },
    d.mcp(),
  ];
  // The order a person does them in: a repo needs the web server up first.
  const order = [
    "node",
    "git",
    "distribution",
    "web",
    "repos",
    "workspaces",
    "docker",
    "service",
    "mcp",
  ];
  const pending = order
    .map((id) => checks.find((c) => c.id === id))
    .filter((c): c is StatusCheck => !!c && c.status !== "ok");
  const first = pending.find((c) => c.status === "todo") ?? pending[0];
  return {
    ok: pending.length === 0,
    checks,
    next: first
      ? {
          id: first.id,
          step: STEPS[first.id] ?? first.detail,
          ...(first.fix ? { command: first.fix } : {}),
        }
      : {
          id: "done",
          step: webOk
            ? "Everything is set up. Open the web page to see your services."
            : "Everything is set up.",
        },
  };
}
