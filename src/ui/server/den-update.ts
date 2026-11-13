/**
 * SRV-1b: the server agent updates its own Den (`den_update`), and a bad
 * version rolls back by itself.
 *
 * Only an install whose Den comes from npm, in the distribution's own
 * node_modules, can be updated this way; a Den run from a checkout is
 * updated with git. The run:
 *
 *   1. finds the exact version (`latest`, or one named) on npm;
 *   2. saves the pin files (package.json, package-lock.json) in
 *      <state>/server-agent/update/, and copies this version's watch
 *      (update-watch.mjs) there: the running version judges the new one;
 *   3. `npm install --save-exact <pkg>@<to>` in the distribution root (a
 *      failure puts the pin back and installs the old one again);
 *   4. runs the new Den's `doctor --json`, and says what it found;
 *   5. starts that watch, leaves SRV-1a's restart note, and restarts.
 *
 * The watch waits `server_agent.update_wait_seconds` for the new version.
 * If it isn't up, the pin goes back, the old version is installed and
 * started, and the agent is told why. The commit of the new pin is the
 * agent's own (its folder is the distribution's repo, server_agent.git).
 */
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** What one command came to (exit code, the end of its output). */
export interface Ran {
  code: number | null;
  out: string;
}

export interface UpdateDeps {
  root: string;
  engine: string;
  stateDir: string;
  /** The engine's package: its name and version (its package.json). */
  pkg: { name: string; version: string };
  /** `npm view <spec> version`: the exact version, or null (no such). */
  npmView: (spec: string) => Promise<string | null>;
  /** npm itself: [cmd, ...args] before npm's own arguments. */
  npm: string[];
  /** This Den's CLI: [cmd, ...args] before the CLI's own arguments. */
  cli: string[];
  run: (argv: string[], cwd: string) => Promise<Ran>;
  /** Start the watch (detached) on its plan file; its pid. */
  watch: (script: string, plan: string) => number | undefined;
  /** SRV-1a's note for the next server (written): its path and contents. */
  note: (reason: string) => { path: string; marker: Record<string, unknown> };
  /** Restart this Den (D64's path, after this answer goes out). */
  restart: () => void;
  port: number;
  pid: number;
  waitMs: number;
  now?: () => number;
}

export type UpdateResult =
  | {
      ok: true;
      from: string;
      to: string;
      restarting: true;
      doctor: string[];
    }
  | { ok: false; error: string; from?: string; to?: string };

export const UPDATE_SPEC_RE = /^(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** A state file newer than this, not finished, is an update in flight. */
const IN_FLIGHT_MS = 60 * 60_000;
const PIN_FILES = ["package.json", "package-lock.json"];

export const updateDir = (stateDir: string) =>
  path.join(stateDir, "server-agent", "update");
export const updateStateFile = (stateDir: string) =>
  path.join(updateDir(stateDir), "state.json");

export interface UpdateState {
  state:
    | "installing"
    | "watching"
    | "good"
    | "rolling_back"
    | "rolled_back"
    | "rollback_failed";
  from: string;
  to: string;
  at: string;
  why?: string;
  pid?: number;
}

export function readUpdateState(stateDir: string): UpdateState | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(updateStateFile(stateDir), "utf8"),
    ) as UpdateState;
    return typeof v?.state === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Why this install can't update itself through npm, or null. Its Den must
 * be <root>/node_modules/<pkg>, the distribution's own install.
 */
export function updateProblem(
  root: string,
  engine: string,
  name: string,
): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const want = path.join(real(root), "node_modules", ...name.split("/"));
  if (real(engine) !== want)
    return `this Den runs from ${engine}, not from the distribution's own node_modules (${want}): update it with git there, then den_restart_server`;
  if (!fs.existsSync(path.join(root, "package.json")))
    return `the distribution has no package.json at ${root}`;
  return null;
}

/** An update already running (installing or watching, and recent). */
function inFlight(stateDir: string, now: number): UpdateState | null {
  const s = readUpdateState(stateDir);
  if (!s || !["installing", "watching", "rolling_back"].includes(s.state))
    return null;
  return now - Date.parse(s.at) < IN_FLIGHT_MS ? s : null;
}

/** Doctor's failing and warning lines, from `doctor --json`. */
function doctorLines(out: string): string[] | null {
  const at = out.indexOf("{");
  if (at < 0) return null;
  try {
    const j = JSON.parse(out.slice(at)) as {
      checks?: { id?: string; status?: string; detail?: string }[];
    };
    return (j.checks ?? [])
      .filter((c) => c.status === "fail" || c.status === "warn")
      .map((c) => `${c.status}: ${c.id ?? "?"}: ${c.detail ?? ""}`.trim());
  } catch {
    return null;
  }
}

export async function updateDen(
  want: string,
  d: UpdateDeps,
): Promise<UpdateResult> {
  const now = d.now ?? Date.now;
  const from = d.pkg.version;
  if (!UPDATE_SPEC_RE.test(want))
    return { ok: false, error: "version: latest, or one like 0.4.44" };
  const problem = updateProblem(d.root, d.engine, d.pkg.name);
  if (problem) return { ok: false, error: problem, from };
  const busy = inFlight(d.stateDir, now());
  if (busy)
    return {
      ok: false,
      error: `an update to ${busy.to} is already ${busy.state.replace("_", " ")} (since ${busy.at})`,
      from,
    };
  const to = await d.npmView(`${d.pkg.name}@${want}`);
  if (!to)
    return { ok: false, error: `npm has no ${d.pkg.name}@${want}`, from };
  if (to === from)
    return { ok: false, error: `Den is on ${to} already`, from, to };

  // The pin as it is now: the rollback puts these back.
  const dir = updateDir(d.stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backups = PIN_FILES.map((f) => {
    const p = path.join(d.root, f);
    if (!fs.existsSync(p)) return { saved: null, path: p };
    const saved = path.join(dir, `${f}.${from}`);
    fs.copyFileSync(p, saved);
    fs.chmodSync(saved, 0o600);
    return { saved, path: p };
  });
  const state = (s: UpdateState["state"], why?: string) =>
    writeJson(updateStateFile(d.stateDir), {
      state: s,
      from,
      to,
      at: new Date(now()).toISOString(),
      ...(why ? { why } : {}),
    } satisfies UpdateState);
  const putBack = async () => {
    for (const b of backups)
      if (b.saved) fs.copyFileSync(b.saved, b.path);
      else fs.rmSync(b.path, { force: true });
    await d.run([...d.npm, "install", "--no-audit", "--no-fund"], d.root);
  };

  // The watch that judges the new version, and rolls it back, is this
  // version's: copied out of the engine before npm replaces it, so a new
  // release with a broken watch (or none) still rolls back.
  const script = path.join(dir, "watch.mjs");
  fs.copyFileSync(
    path.join(d.engine, "src/ui/server/update-watch.mjs"),
    script,
  );

  state("installing");
  const inst = await d.run(
    [
      ...d.npm,
      "install",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `${d.pkg.name}@${to}`,
    ],
    d.root,
  );
  if (inst.code !== 0) {
    await putBack();
    const why = `npm install of ${to} failed (exit ${inst.code}): ${tail(inst.out)}`;
    state("rolled_back", why);
    return {
      ok: false,
      error: `${why}. The pin is back on ${from}.`,
      from,
      to,
    };
  }

  const doc = await d.run([...d.cli, "doctor", "--json"], d.root);
  const lines = doctorLines(doc.out);
  if (lines === null) {
    await putBack();
    const why = `Den ${to}'s doctor didn't run (exit ${doc.code}): ${tail(doc.out)}`;
    state("rolled_back", why);
    return {
      ok: false,
      error: `${why}. The pin is back on ${from}.`,
      from,
      to,
    };
  }

  const plan = path.join(dir, "plan.json");
  writeJson(plan, {
    port: d.port,
    from,
    to,
    fromPid: d.pid,
    waitMs: d.waitMs,
    root: d.root,
    backups,
    npm: [...d.npm, "install", "--no-audit", "--no-fund"],
    restart: [
      ...d.cli,
      "web",
      "restart",
      "--no-open",
      "--port",
      String(d.port),
    ],
    stateFile: updateStateFile(d.stateDir),
    restartMarker: d.note(`update Den ${from} → ${to}`),
  });
  state("watching");
  d.watch(script, plan);
  d.restart();
  return { ok: true, from, to, restarting: true, doctor: lines };
}

const tail = (s: string) =>
  s.trim().split("\n").slice(-3).join(" / ").slice(0, 400);

/**
 * npm as this node runs it: the npm beside this node binary (a launchd
 * service's PATH may have none), else `npm` from PATH.
 */
export function npmCommand(execPath: string = process.execPath): string[] {
  const cli = path.join(
    path.dirname(execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return fs.existsSync(cli) ? [execPath, cli] : ["npm"];
}

/** A command, its output (both streams), exit code; 10 minutes at most. */
export function runCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
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
    );
  });
}

/** `npm view <spec> version --json`: the exact version, or null. */
export async function npmViewVersion(
  npm: string[],
  spec: string,
  cwd: string,
): Promise<string | null> {
  const r = await runCommand([...npm, "view", spec, "version", "--json"], cwd);
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.out.trim()) as unknown;
    const last = Array.isArray(v) ? v.at(-1) : v;
    return typeof last === "string" &&
      UPDATE_SPEC_RE.test(last) &&
      last !== "latest"
      ? last
      : null;
  } catch {
    return null;
  }
}

/** Start the watch, detached from this server (it outlives it). */
export function spawnWatch(
  script: string,
  plan: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
): number | undefined {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  try {
    const c = spawn(process.execPath, [script, plan], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    c.unref();
    return c.pid;
  } finally {
    fs.closeSync(fd);
  }
}
