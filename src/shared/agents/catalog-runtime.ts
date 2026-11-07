/**
 * A runtime from a catalog entry (AG-0.5, catalog.ts): found by AG-0.1's
 * search with the entry's binary names and install directories, and
 * launched as its interactive CLI in the agent's directory (the entry's
 * launch argv, "{bin}" the path found).
 *
 * These don't get Den's tools yet: no MCP config, no permission mode
 * (AG-12 and AG-13 wire them per runtime). Lists tag them "Den tools:
 * coming" (denTools: false). Claude Code is den-claude, which takes its
 * search from the catalog and keeps its own launch.
 *
 * checkRuntimeBin is what "Set path…" runs: the entry's version command,
 * and the entry's identity (its output names it, it resolves into the
 * vendor's npm package, or under the vendor's install directory), so a
 * path that isn't that runtime is refused.
 */
import * as fs from "fs";
import * as path from "path";
import { configuredRuntimeBin } from "../den-config.js";
import { entryDirs, type CatalogEntry } from "./catalog.js";
import {
  LaunchError,
  type DetectOptions,
  type LaunchOutput,
  type Runtime,
  type RuntimeDetect,
} from "./runtime.js";
import {
  locateRuntime,
  parseVersion,
  systemBinDirs,
  versionOutput,
  type RuntimeFind,
} from "./runtime-search.js";

/** An entry as AG-0.1's search takes it. */
export function catalogFind(e: CatalogEntry): RuntimeFind {
  return {
    bins: e.bins,
    dirs: (home, env) => entryDirs(e, home, env, systemBinDirs),
    versionArgs: e.version.args,
  };
}

/** Find an entry's CLI: a setting (workspace or global), else the search. */
export function detectEntry(
  e: CatalogEntry,
  find: RuntimeFind,
  env: NodeJS.ProcessEnv,
  opts: DetectOptions,
): RuntimeDetect {
  const setting =
    opts.bin === undefined ? configuredRuntimeBin(e.id) : opts.bin;
  const found = locateRuntime(e.id, find, env, setting);
  if (!found.available || !found.path)
    return {
      available: false,
      why: found.why ?? `${e.bins.join(" or ")} not found`,
      ...(found.source ? { source: found.source } : {}),
      searched: found.searched,
    };
  return {
    available: true,
    path: found.path,
    ...(found.source ? { source: found.source } : {}),
    searched: found.searched,
  };
}

/** The launch argv: the entry's template, "{bin}" the path found. */
export function launchArgv(e: CatalogEntry, bin: string): string[] {
  return e.launch.argv.map((a) => a.split("{bin}").join(bin));
}

/** A runtime for a catalog entry other than Claude Code (den-claude). */
export function catalogRuntime(e: CatalogEntry): Runtime {
  const find = catalogFind(e);
  const detect = (
    env: NodeJS.ProcessEnv = process.env,
    opts: DetectOptions = {},
  ) => detectEntry(e, find, env, opts);
  return {
    id: e.id,
    label: e.name,
    vendor: e.vendor,
    catalog: e,
    find,
    denTools: false,
    detect,
    launch(input): LaunchOutput {
      let bin = input.bin;
      if (!bin) {
        const d = detect(input.env);
        if (!d.available || !d.path)
          throw new LaunchError(`${e.id}: ${d.why ?? "not found"}`);
        bin = d.path;
      }
      return {
        argv: launchArgv(e, bin),
        env: {},
        warnings: [
          `${e.name} runs as its own CLI in ${input.worktree}: Den's tools (MCP) and permission modes are coming for it`,
        ],
      };
    },
    approvals: "terminal",
    scrubEnv: [],
  };
}

/** The npm package a file resolves into (the nearest package.json's name). */
function packageOf(real: string): string | undefined {
  for (let dir = path.dirname(real), i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
      ) as { name?: unknown };
      if (typeof pkg.name === "string") return pkg.name;
    } catch {
      /* not here */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

export type BinCheck =
  | { ok: true; path: string; version: string }
  | { ok: false; why: string };

/**
 * Whether `bin` is entry `e`'s runtime: an absolute path to an executable
 * file whose version command exits 0 and prints a version, and whose
 * output, npm package or real location names it. Runs only that command
 * (stdin closed, under a timeout). Never throws.
 */
export async function checkRuntimeBin(
  e: CatalogEntry,
  bin: string,
  env: NodeJS.ProcessEnv,
): Promise<BinCheck> {
  const p = bin.trim();
  const shown = p.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  if (!path.isAbsolute(p))
    return { ok: false, why: `"${shown}" is not an absolute path` };
  let real: string;
  try {
    const st = fs.statSync(p);
    fs.accessSync(p, fs.constants.X_OK);
    if (!st.isFile()) throw new Error("not a file");
    real = fs.realpathSync(p);
  } catch {
    return { ok: false, why: `${shown} is not an executable file` };
  }
  const cmd = `${path.basename(p)} ${e.version.args.join(" ")}`;
  const r = await versionOutput(p, e.version.args, env);
  if (!r.ok) return { ok: false, why: `\`${cmd}\` failed: not ${e.name}` };
  const version = parseVersion(r.out);
  if (!version)
    return { ok: false, why: `\`${cmd}\` printed no version: not ${e.name}` };
  const idn = e.version.identity;
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : undefined;
  const under = (idn.realpath_under ?? []).flatMap((d) =>
    d.startsWith("~/") ? (home ? [path.join(home, d.slice(2))] : []) : [d],
  );
  const named =
    (idn.output !== undefined && new RegExp(idn.output, "i").test(r.out)) ||
    (idn.package !== undefined && packageOf(real) === idn.package) ||
    under.some((d) => real === d || real.startsWith(d + path.sep));
  if (!named)
    return {
      ok: false,
      why: `${shown} is not ${e.name}: its version output, package and location don't name it`,
    };
  return { ok: true, path: p, version };
}
