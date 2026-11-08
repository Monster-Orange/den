/**
 * `<cli> repo add <path|git-url> [--sidecar] [-w <ws>] [--name <n>]
 * [--run "<cmd>"] [--down "<cmd>"] [--health <url>] [--branch <b>] [--json]`
 * (ON-2): add a repo to a workspace with no prompts, and without changing
 * the repo.
 *
 * - A path is a checkout of the person's own: added dev-managed, at its path.
 *   A git URL is cloned where Den keeps its managed clones
 *   (`<servicesDir>/<repo>/<branch>`, ensureManagedServiceClone) and added
 *   managed.
 * - A repo with its own manifest is used as is. One without (or with
 *   `--sidecar`) gets a side-car manifest written into the distribution's
 *   `manifests/<repo><manifest ext>`, the held-manifest layer of "Overriding
 *   a manifest" (docs/distributions.md): Den reads it for that repo, the
 *   repo is never written. Its commands come from repo-detect.ts and it is
 *   validated by the manifest validator before it is written.
 * - Detection that cannot decide writes nothing and answers with a question
 *   and its choices; a re-run passes `--run "<cmd>"`.
 * - Safe to re-run: the same repo in the same workspace answers ok with
 *   existed: true, and an existing side-car is never overwritten.
 * - The workspace: `-w <ws>` (created and activated when missing), else the
 *   focused one, else a new `default` workspace, activated and focused.
 * - `--dry-run` (ON-3, the MCP tool manifest_draft's twin): a local path
 *   only. Detection and the validator run as above, and the answer carries
 *   the side-car as YAML (`draft`) and `validation`; nothing is written, not
 *   the side-car, the workspace entry or the catalog.
 *
 * `<cli> repo detect <folder> [--json]` (ON-3, repos_detect's twin): the git
 * repos in a folder and suggested workspaces (onboard-reads.ts).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { product } from "../../shared/product.js";
import { getDistRoot, getInvokeCwd } from "../../shared/paths.js";
import {
  heldManifestPath,
  heldManifestsDir,
  originRepoName,
  readManifest,
  repoManifestPath,
} from "../../shared/manifest/read-manifest.js";
import { formatManifestYaml } from "./init.js";
import {
  DEN_SERVICES_DIR,
  getFocusedWorkspaceName,
  readWorkspacesFile,
  writeWorkspacesFile,
} from "../../shared/environment-manager/workspaces.js";
import {
  readCatalog,
  upsertCatalogEntry,
} from "../../shared/environment-manager/catalog.js";
import {
  isGitRemote,
  isSafeRemote,
  redactRemote,
} from "../../shared/environment-manager/git-remote.js";
import { ensureManagedServiceClone } from "../../shared/environment-manager/workspace-manager.js";
import { getGitHubCoords } from "../../shared/smoke/git-remote.js";
import {
  detectRunCommands,
  draftHealthUrl,
  repoNameFrom,
  sidecarManifest,
  type DetectedCommands,
} from "./repo-detect.js";
import { printJson, quietStdout } from "./json-out.js";

export interface RepoAddArgs {
  spec: string;
  sidecar: boolean;
  workspace?: string;
  name?: string;
  run?: string;
  down?: string;
  health?: string;
  branch?: string;
  json: boolean;
  /** `--dry-run`: detect and validate, write nothing (a local path only). */
  dryRun?: boolean;
}

export interface RepoAddResult {
  ok: boolean;
  existed?: boolean;
  repo?: string;
  workspace?: string;
  mode?: "dev-managed" | "managed";
  path?: string;
  /** Where the manifest Den uses comes from. */
  manifest?: {
    source: "repo" | "sidecar";
    file: string;
    /** True when this run wrote the side-car. */
    written?: boolean;
    /** How the commands were found, when this run detected them. */
    detected?: DetectedCommands["source"];
  };
  services?: string[];
  next?: string[];
  error?: string;
  fix?: string;
  ask?: string;
  choices?: string[];
  /** `--dry-run`: nothing was written. */
  dryRun?: boolean;
  /** `--dry-run`: the side-car Den would write, as YAML. */
  draft?: string;
  /** `--dry-run`: the validator's answer for the draft. */
  validation?: { valid: boolean; errors: { path: string; message: string }[] };
}

const USAGE = () =>
  `${product().cli} repo add <path|git-url> [--sidecar] [-w <workspace>] [--name <repo>] ` +
  `[--run "<cmd>"] [--down "<cmd>"] [--health <url>] [--branch <branch>] [--dry-run] [--json]`;

export const REPO_HELP = () =>
  [
    `\n  ${USAGE()}\n`,
    "  Add a repo to a workspace, with no prompts and without changing the repo.",
    "  A path is your own checkout (dev-managed); a git URL is cloned where Den",
    "  keeps its managed clones. A repo with no manifest of its own, or with",
    "  --sidecar, gets a side-car manifest in this distribution's manifests/",
    "  (never in the repo), detected from its Makefile (an `up` target), its",
    "  compose file or its package.json scripts (dev, start, test). When that",
    '  cannot decide, nothing is written and --json answers with "ask" and',
    '  "choices": re-run with --run "<cmd>". --health <url> adds an HTTP health',
    "  check. -w picks the workspace (default: the focused one, else a new",
    "  `default`). Safe to re-run: the same repo answers existed: true.",
    "  --dry-run (a local folder only): detect and validate the side-car and",
    '  print it ("draft"), writing nothing: no side-car, no workspace entry.\n',
    `\n  ${product().cli} repo detect <folder> [--json]\n`,
    "  Find the git repos in a folder inside your home (one or two levels deep),",
    "  say how each one runs, and suggest workspaces: the repos in one parent",
    "  folder go in one workspace named after it. Reads only: it never writes,",
    "  never runs a repo's tools and never follows a symlink.\n",
  ].join("\n");

const VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "--name",
  "--run",
  "--down",
  "--health",
  "--branch",
]);

export function parseRepoAddArgs(argv: string[]): RepoAddArgs {
  const out: Partial<RepoAddArgs> & { sidecar: boolean; json: boolean } = {
    sidecar: false,
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (a === "--sidecar") out.sidecar = true;
    else if (a === "--json") out.json = true;
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (VALUE_FLAGS.has(flag)) {
      const v = flag !== a ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "") throw new Error(`${flag} needs a value`);
      if (flag === "-w" || flag === "--workspace") out.workspace = v;
      else if (flag === "--name") out.name = v;
      else if (flag === "--run") out.run = v;
      else if (flag === "--down") out.down = v;
      else if (flag === "--health") out.health = v;
      else out.branch = v;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1)
    throw new Error("repo add needs one <path|git-url>");
  return { ...out, spec: positional[0] } as RepoAddArgs;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The command an agent runs from the distribution root. */
function runnable(): string {
  const cli = product().cli;
  return fs.existsSync(path.join(getDistRoot(), "bin", cli))
    ? `./bin/${cli}`
    : cli;
}

/** A spec is a git URL when it is not a directory here and looks like one. */
function isUrlSpec(spec: string, cwd: string): boolean {
  if (fs.existsSync(path.resolve(cwd, spec))) return false;
  return (
    /^(https?|ssh|git|file):\/\//.test(spec) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(spec)
  );
}

/** The remote's default branch (`git ls-remote --symref`), or "main". */
function defaultBranchOf(url: string): string {
  try {
    const out = execFileSync("git", ["ls-remote", "--symref", url, "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    return /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1] ?? "main";
  } catch {
    return "main";
  }
}

/** The workspace to write: -w (made when missing), the focus, or `default`. */
function targetWorkspace(named: string | undefined): {
  name: string;
  created: boolean;
} {
  const file = readWorkspacesFile();
  const name = named ?? getFocusedWorkspaceName() ?? "default";
  if (file.workspaces[name]) return { name, created: false };
  file.workspaces[name] = { services: {} };
  if (!file.active.includes(name)) file.active.push(name);
  if (!file.focus || !file.workspaces[file.focus]) file.focus = name;
  writeWorkspacesFile(file);
  return { name, created: true };
}

function sidecarFile(key: string): string {
  return path.join(heldManifestsDir(), `${key}${product().manifestYml}`);
}

/**
 * The manifest validator (validate-manifest.ts's validateManifest), passed
 * in by the CLI entry: this module stays out of the type-checked program's
 * zod-drift baseline (tsconfig.typecheck.json) that file is in.
 */
export type ManifestValidator = (manifest: unknown) => {
  valid: boolean;
  errors: { path: string; message: string }[];
};

/** Run `repo add` as data. Never prompts; throws only on a bug. */
export function repoAdd(
  a: RepoAddArgs,
  validate: ManifestValidator,
  cwd: string = getInvokeCwd(),
): RepoAddResult {
  const bin = runnable();
  const url = isUrlSpec(a.spec, cwd);
  if (a.name !== undefined && !NAME_RE.test(a.name))
    return {
      ok: false,
      error: `--name "${a.name}" must use only letters, digits, ".", "_" and "-"`,
      ask: "Which name should Den use for this repo?",
    };
  if (a.health !== undefined && !/^https?:\/\/\S+$/.test(a.health))
    return {
      ok: false,
      error: `--health "${a.health}" must be an http(s) URL`,
      fix: `${bin} repo add ${a.spec} --health http://localhost:<port>/ --json`,
    };

  if (a.dryRun && url)
    return {
      ok: false,
      dryRun: true,
      error:
        "--dry-run takes a local folder: a git URL would have to be cloned first",
      fix: `${bin} repo add <path> --dry-run --json`,
    };

  // ── Where the repo is ────────────────────────────────────────────────────
  let repoPath: string;
  let mode: "dev-managed" | "managed";
  let branch: string | undefined;
  let name: string;
  if (url) {
    if (!isSafeRemote(a.spec) || !isGitRemote(a.spec))
      return {
        ok: false,
        error: `${redactRemote(a.spec)} is not a git URL Den can clone (https://, ssh://, git://, file://, user@host:path)`,
        ask: "What is the repo's clone URL, or the path of a local checkout?",
      };
    name = a.name ?? repoNameFrom(a.spec);
    if (!NAME_RE.test(name))
      return {
        ok: false,
        error: `cannot name a repo from ${redactRemote(a.spec)}`,
        fix: `${bin} repo add ${a.spec} --name <repo> --json`,
      };
    branch = a.branch ?? defaultBranchOf(a.spec);
    mode = "managed";
    const existing = path.join(DEN_SERVICES_DIR, name, branch);
    try {
      // A clone that is there is used as is: adding a repo never pulls
      // (`up --pull` and `sync` do), so a re-run touches no network.
      repoPath = fs.existsSync(path.join(existing, ".git"))
        ? existing
        : ensureManagedServiceClone(name, a.spec, branch, false);
    } catch (e) {
      if (!fs.existsSync(path.join(existing, ".git")))
        return {
          ok: false,
          error: `could not clone ${redactRemote(a.spec)}@${branch}: ${(e as Error).message.split("\n")[0]}`,
          ask: "Can you clone this URL with git on this machine (is access set up)? If the default branch is not main, which branch should Den use?",
          fix: `${bin} repo add ${a.spec} --branch <branch> --json`,
        };
      repoPath = existing; // a pull failed; the clone is there
    }
  } else {
    repoPath = path.resolve(cwd, a.spec);
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory())
      return {
        ok: false,
        error: `no folder at ${repoPath}`,
        ask: "Which folder holds the repo? (a local path, or a git URL to clone)",
      };
    mode = "dev-managed";
    name = "";
  }

  // ── Its manifest: the repo's own, or a side-car ──────────────────────────
  const own = repoManifestPath(repoPath);
  if (own && a.sidecar)
    return {
      ok: false,
      error: `${repoPath} has its own manifest (${path.basename(own)}), and Den always uses a repo's own manifest over a side-car`,
      fix: `${bin} repo add ${a.spec} --json`,
      ask: `Use the repo's own ${path.basename(own)} as it is? To change what this distribution runs, Den reads manifests/<repo>.override${path.extname(product().manifestYml)} on top of it.`,
    };
  const key = url
    ? (originRepoName(repoPath) ?? name)
    : (originRepoName(repoPath) ?? path.basename(repoPath));
  let manifestInfo: RepoAddResult["manifest"];
  /** --dry-run: the side-car that would be written. */
  let drafted:
    | { manifest: Record<string, unknown>; text: string; valid: boolean }
    | undefined;
  if (own) {
    manifestInfo = { source: "repo", file: own };
  } else {
    const held = heldManifestPath(repoPath);
    if (held) {
      manifestInfo = { source: "sidecar", file: held, written: false };
    } else {
      const d = detectRunCommands(repoPath, { run: a.run, down: a.down });
      if (!d.decided)
        return {
          ok: false,
          error: `Den could not tell how ${repoPath} starts`,
          ask: d.ask,
          choices: d.choices,
          fix: `${bin} repo add ${a.spec}${a.sidecar ? " --sidecar" : ""} --run "${d.choices[0] ?? "<command>"}" --json`,
        };
      const mName = a.name ?? (url ? name : key);
      if (!NAME_RE.test(mName))
        return {
          ok: false,
          error: `cannot name a repo from the folder "${key}"`,
          fix: `${bin} repo add ${a.spec} --name <repo> --json`,
        };
      // No --health: the dev server's own port, when its script names one,
      // so the drafted service has a health check and a Visit link.
      const manifest = sidecarManifest(
        mName,
        d.commands,
        a.health ?? draftHealthUrl(repoPath, d.commands),
      );
      const v = validate(manifest);
      const dry = a.dryRun
        ? {
            dryRun: true,
            draft: formatManifestYaml(manifest),
            validation: { valid: v.valid, errors: v.errors },
          }
        : {};
      if (!v.valid)
        return {
          ok: false,
          error: `the detected manifest is not valid: ${v.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
          fix: `${bin} repo add ${a.spec} --run "<command>" --json`,
          ...dry,
        };
      const file = sidecarFile(key);
      if (a.dryRun) {
        drafted = { manifest, text: dry.draft as string, valid: v.valid };
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // "wx": never overwrite a side-car someone may have edited.
        fs.writeFileSync(file, formatManifestYaml(manifest), {
          encoding: "utf-8",
          flag: "wx",
        });
      }
      manifestInfo = {
        source: "sidecar",
        file,
        written: !a.dryRun,
        detected: d.commands.source,
      };
    }
  }

  const manifest = drafted
    ? (drafted.manifest as unknown as ReturnType<typeof readManifest>)
    : readManifest(repoPath);
  if (!manifest)
    return {
      ok: false,
      error: `Den cannot read the manifest at ${manifestInfo.file}`,
      fix: `${bin} validate ${repoPath}`,
    };
  if (!url)
    name =
      a.name ??
      (typeof manifest.name === "string" && manifest.name
        ? manifest.name
        : path.basename(repoPath));
  if (!NAME_RE.test(name))
    return {
      ok: false,
      error: `cannot use "${name}" as a repo name`,
      fix: `${bin} repo add ${a.spec} --name <repo> --json`,
    };

  if (a.dryRun) {
    // Nothing is written: not the side-car, not the workspace entry.
    const flags = [
      a.name !== undefined ? ` --name ${a.name}` : "",
      a.run !== undefined ? ` --run "${a.run}"` : "",
      a.down !== undefined ? ` --down "${a.down}"` : "",
      a.health !== undefined ? ` --health ${a.health}` : "",
      a.workspace !== undefined ? ` -w ${a.workspace}` : "",
    ].join("");
    return {
      ok: true,
      dryRun: true,
      repo: name,
      workspace: a.workspace ?? getFocusedWorkspaceName() ?? "default",
      mode,
      path: repoPath,
      manifest: manifestInfo,
      services: Object.keys(manifest.services ?? {}),
      ...(drafted
        ? {
            draft: drafted.text,
            validation: { valid: drafted.valid, errors: [] },
          }
        : {}),
      next: [`${bin} repo add ${a.spec}${flags} --json`],
    };
  }

  // ── The workspace entry ──────────────────────────────────────────────────
  const ws = targetWorkspace(a.workspace);
  const file = readWorkspacesFile();
  const entries = file.workspaces[ws.name].services;
  const mine = Object.keys(entries).filter(
    (k) => k === name || k.startsWith(`${name}/`),
  );
  const same = (k: string) =>
    entries[k].mode === mode &&
    (mode === "dev-managed"
      ? path.resolve(entries[k].path ?? "") === repoPath
      : (entries[k].branch ?? "main") === branch);
  const services = Object.keys(manifest.services ?? {});
  const next = [
    `${bin} up ${name} --json`,
    `${bin} web up --no-open --json`,
    `${bin} doctor --json`,
  ];
  const base = {
    repo: name,
    workspace: ws.name,
    mode,
    path: repoPath,
    manifest: manifestInfo,
    services,
    next,
  };
  if (mine.length > 0 && mine.every(same))
    return { ok: true, existed: true, ...base };
  if (mine.length > 0)
    return {
      ok: false,
      error: `workspace "${ws.name}" already has a different "${name}" (${mine.map((k) => entries[k].path ?? `managed ${entries[k].branch ?? "main"}`).join(", ")})`,
      ask: `Replace the "${name}" in workspace "${ws.name}" with ${repoPath}, or add this one under another name?`,
      fix: `${bin} relocate ${name} ${repoPath} -w ${ws.name}`,
      choices: [
        `${bin} relocate ${name} ${repoPath} -w ${ws.name}`,
        `${bin} repo add ${a.spec} --name <other-name> --json`,
      ],
    };
  entries[name] =
    mode === "managed"
      ? { mode, branch: branch ?? "main" }
      : { mode, path: repoPath };
  writeWorkspacesFile(file);
  if (mode === "managed") {
    upsertCatalogEntry(name, { gh: "", remote: a.spec });
  } else if (!readCatalog()[name]) {
    const coords = getGitHubCoords(repoPath);
    upsertCatalogEntry(name, {
      gh: coords ? `${coords.owner}/${coords.repo}` : "",
    });
  }
  return { ok: true, existed: false, ...base };
}

function printHuman(r: RepoAddResult): void {
  if (r.dryRun && r.ok) {
    console.log(
      `✓ Dry run: ${r.repo} would be added to workspace ${r.workspace} (${r.mode}, ${r.path}); nothing was written`,
    );
    if (r.manifest)
      console.log(
        `  manifest: ${r.manifest.source} ${r.manifest.file}${r.draft ? ` (would be written, from ${r.manifest.detected})` : ""}`,
      );
    if (r.draft) console.log(`\n${r.draft.replace(/^/gm, "    ")}`);
    console.log(`  To add it: ${r.next?.[0] ?? ""}`);
    return;
  }
  if (!r.ok) {
    console.error(`✗ repo add: ${r.error}`);
    if (r.ask) console.error(`  ${r.ask}`);
    for (const c of r.choices ?? []) console.error(`    - ${c}`);
    if (r.fix) console.error(`  Run: ${r.fix}`);
    return;
  }
  console.log(
    r.existed
      ? `✓ ${r.repo} is already in workspace ${r.workspace} (${r.mode}, ${r.path})`
      : `✓ Added ${r.repo} to workspace ${r.workspace} (${r.mode}, ${r.path})`,
  );
  if (r.manifest)
    console.log(
      `  manifest: ${r.manifest.source} ${r.manifest.file}${r.manifest.written ? ` (written, from ${r.manifest.detected})` : ""}`,
    );
  console.log(`  Next: ${r.next?.[0] ?? ""}`);
}

/** `repo detect <folder> [--json]` (ON-3, repos_detect's twin). */
async function cmdRepoDetect(argv: string[]): Promise<number> {
  const { processPathRules, reposDetect } = await import("./onboard-reads.js");
  const { registeredRepos } = await import("./onboard-command.js");
  const { getStateDir } = await import("../../shared/paths.js");
  const json = argv.includes("--json");
  const positional = argv.filter((a) => a !== "--json");
  const bad = positional.find((a) => a.startsWith("-"));
  if (bad || positional.length !== 1) {
    const r = {
      ok: false,
      error: bad ? `unknown flag ${bad}` : "repo detect needs one <folder>",
      fix: `${runnable()} repo detect <folder> --json`,
    };
    if (json) printJson(r);
    else console.error(`✗ repo detect: ${r.error}`);
    return 2;
  }
  // A relative folder is the person's own, from where they typed it.
  const given = positional[0];
  const folder =
    given.startsWith("~") || path.isAbsolute(given)
      ? given
      : path.resolve(getInvokeCwd(), given);
  const r = reposDetect(folder, processPathRules(getStateDir()), {
    registered: registeredRepos,
    bin: runnable(),
  });
  if (json) printJson(r);
  else if (!r.ok) console.error(`✗ repo detect: ${r.error}`);
  else {
    console.log(
      `✓ ${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} in ${r.path}${r.truncated ? " (stopped early: more are there)" : ""}`,
    );
    for (const x of r.repos) {
      const how = x.runs
        ? x.runs.up
        : x.manifest !== "none"
          ? `its ${x.manifest === "repo" ? "own" : "side-car"} manifest`
          : (x.ask ?? "");
      const inWs = x.registered?.length
        ? ` (in ${x.registered.map((g) => g.workspace).join(", ")})`
        : "";
      console.log(`  ${x.name.padEnd(20)} ${how}${inWs}`);
    }
    if (r.workspaces.length) {
      console.log("\n  Suggested workspaces:");
      for (const w of r.workspaces)
        console.log(`  ${w.name.padEnd(20)} ${w.repos.join(", ")}`);
    }
    if (r.next[0]) console.log(`\n  Next: ${r.next[0]}`);
  }
  return r.ok ? 0 : 1;
}

/** `repo <sub> …`; returns the exit code. */
export async function cmdRepo(
  argv: string[],
  validate: ManifestValidator,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || rest.includes("--help")) {
    console.log(REPO_HELP());
    return sub ? 0 : 1;
  }
  const json = rest.includes("--json");
  if (sub === "detect") return cmdRepoDetect(rest);
  if (sub !== "add") {
    const r = {
      ok: false,
      error: `unknown repo subcommand "${sub}"`,
      fix: `${runnable()} repo add <path|git-url> --json`,
    };
    if (json) printJson(r);
    else console.error(`✗ ${r.error}\n${REPO_HELP()}`);
    return 2;
  }
  let args: RepoAddArgs;
  try {
    args = parseRepoAddArgs(rest);
  } catch (e) {
    const r = {
      ok: false,
      error: (e as Error).message,
      fix: `${runnable()} repo add <path|git-url> --json`,
    };
    if (json) printJson(r);
    else console.error(`✗ repo add: ${r.error}\n  usage: ${USAGE()}`);
    return 2;
  }
  let r: RepoAddResult;
  try {
    r = args.json
      ? await quietStdout(async () => repoAdd(args, validate))
      : repoAdd(args, validate);
  } catch (e) {
    r = { ok: false, error: (e as Error).message };
  }
  if (args.json) printJson(r);
  else printHuman(r);
  return r.ok ? 0 : 1;
}
