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
 *   4. runs the new Den's `doctor --json`, says what it found, and keeps
 *      its fail and warn lines beside the update's state (doctor.json), for
 *      release_status (#176);
 *   5. starts that watch, leaves SRV-1a's restart note, and restarts.
 *
 * The watch waits `server_agent.update_wait_seconds` for the new version.
 * If it isn't up, the pin goes back, the old version is installed and
 * started, and the agent is told why. Once the watch says "good", the new
 * Den commits and pushes the new pin itself (#176, pin-commit.ts).
 */
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { readPinRecord, type PinRecord } from "../../shared/pin-record.js";

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
  /**
   * Issue 562 review: after the install and doctor, before the watch
   * starts and Den restarts: wait for a quiet moment again (the install
   * takes a while, and a turn may have started). It always resolves.
   * It calls `keepAlive` as it waits, so a hold longer than the in-flight
   * hour still marks the update under way (no second one starts).
   */
  beforeRestart?: (keepAlive: () => void) => Promise<void>;
  /** Restart this Den (D64's path, after this answer goes out). */
  restart: () => void;
  restartEnv?: Record<string, string>;
  port: number;
  pid: number;
  waitMs: number;
  now?: () => number;
  /**
   * Issue 1403: a routine update on a personal install. The version npm
   * resolves to must be a stable release at or above the running one, or
   * nothing happens and the person decides (needsPerson).
   */
  stableNotOlder?: boolean;
}

/**
 * Issue 1403 (Den Builder): whether `to` is a stable release (no
 * prerelease or dev tag) at or above `from`, the running version. A
 * version that can't be read is neither.
 */
export function stableNotOlder(to: string, from: string | null): boolean {
  const core = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v);
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] !== undefined } : null;
  };
  const t = core(to);
  const f = from ? core(from) : null;
  if (!t || !f || t.pre) return false;
  for (let i = 0; i < 3; i++) if (t.n[i] !== f.n[i]) return t.n[i] > f.n[i];
  return true; // the same release, or the release of a running prerelease
}

export type UpdateResult =
  | {
      ok: true;
      from: string;
      to: string;
      restarting: true;
      doctor: string[];
    }
  | {
      ok: false;
      error: string;
      from?: string;
      to?: string;
      /** Issue 1403: a routine update stopped; the person decides. */
      needsPerson?: true;
      rollbackFailed?: RollbackFailed;
    };

export interface RollbackFailed {
  from: string;
  root: string;
  why: string;
}

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

/**
 * #176: the new Den's doctor results (`doctor --json`'s fail and warn
 * lines: check ids and details, never a value from the env), kept beside
 * the state. The watch rewrites state.json with its verdict alone, so they
 * live in a file of their own, for the same from and to.
 */
export const updateDoctorFile = (stateDir: string) =>
  path.join(updateDir(stateDir), "doctor.json");

export interface UpdateDoctor {
  from: string;
  to: string;
  at: string;
  lines: string[];
}

/** The last update, and its doctor results when doctor ran for it. */
export type LastUpdate = UpdateState & {
  doctor?: { at: string; lines: string[] };
  pin?: Omit<PinRecord, "noted">;
};

function readUpdateDoctor(stateDir: string): UpdateDoctor | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(updateDoctorFile(stateDir), "utf8"),
    ) as Partial<UpdateDoctor>;
    return typeof v?.from === "string" &&
      typeof v.to === "string" &&
      typeof v.at === "string" &&
      Array.isArray(v.lines)
      ? {
          from: v.from,
          to: v.to,
          at: v.at,
          lines: v.lines.map((l) => String(l)),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * #176: what release_status and the page show of Den's last update of
 * itself: its state (from, to, when, why) and, when the new Den's doctor
 * ran for that same update, what it found. Null: none.
 */
export function lastUpdate(stateDir: string): LastUpdate | null {
  const s = readUpdateState(stateDir);
  if (!s) return null;
  const d = readUpdateDoctor(stateDir);
  const rec = readPinRecord(stateDir);
  const pin = rec ? (({ noted: _n, ...r }) => r)(rec) : null;
  return {
    ...s,
    ...(d && d.from === s.from && d.to === s.to
      ? { doctor: { at: d.at, lines: d.lines } }
      : {}),
    ...(pin ? { pin } : {}),
  };
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
  writeFileAtomic(file, JSON.stringify(v) + "\n", { mode: 0o600 });
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
  // Issue 1403: checked again against what "latest" (or the version named)
  // is now, and the version running now. Nothing is touched yet.
  if (d.stableNotOlder && !stableNotOlder(to, from))
    return {
      ok: false,
      needsPerson: true,
      error: `${to} is not a stable release at or above ${from}, the version running: the person decides`,
      from,
      to,
    };
  if (to === from)
    return { ok: false, error: `Den is on ${to} already`, from, to };

  // The pin as it is now: the rollback puts these back.
  const dir = updateDir(d.stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // #176: the last update's doctor results are no longer this one's.
  fs.rmSync(updateDoctorFile(d.stateDir), { force: true });
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
  // Puts the saved pin back and installs the old version again. Its
  // answer is why that failed, or null when the old version is back.
  const putBack = async (): Promise<string | null> => {
    try {
      for (const b of backups)
        if (b.saved) fs.copyFileSync(b.saved, b.path);
        else fs.rmSync(b.path, { force: true });
    } catch (e) {
      return `could not put the pin files back: ${(e as Error).message}`;
    }
    let npm: Ran;
    try {
      npm = await d.run(
        [...d.npm, "install", "--no-audit", "--no-fund"],
        d.root,
      );
    } catch (e) {
      return `npm install of ${from} did not run: ${(e as Error).message}`;
    }
    return npm.code === 0
      ? null
      : `npm install of ${from} failed (exit ${npm.code}): ${tail(npm.out)}`;
  };
  // Rolls back after `why`, and says honestly whether the old version is
  // back. The state never stays at "installing".
  const rollBack = async (why: string): Promise<UpdateResult> => {
    state("rolling_back", why);
    const failed = await putBack();
    if (failed) {
      const both = `${why}; ${failed}`;
      state("rollback_failed", both);
      return {
        ok: false,
        error: `${both}. The rollback failed: Den ${from} may not start. A person must put the pin back on ${from} in ${d.root} and run npm install there.`,
        from,
        to,
        rollbackFailed: { from, root: d.root, why: both },
      };
    }
    state("rolled_back", why);
    return {
      ok: false,
      error: `${why}. The pin is back on ${from}.`,
      from,
      to,
    };
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
  let lines: string[] | null;
  try {
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
    if (inst.code !== 0)
      return await rollBack(
        `npm install of ${to} failed (exit ${inst.code}): ${tail(inst.out)}`,
      );

    const doc = await d.run([...d.cli, "doctor", "--json"], d.root);
    lines = doctorLines(doc.out);
    if (lines === null)
      return await rollBack(
        `Den ${to}'s doctor didn't run (exit ${doc.code}): ${tail(doc.out)}`,
      );
    try {
      writeJson(updateDoctorFile(d.stateDir), {
        from,
        to,
        at: new Date(now()).toISOString(),
        lines,
      } satisfies UpdateDoctor);
    } catch {
      /* best effort: the answer still carries them */
    }
  } catch (e) {
    return await rollBack(
      `the update to ${to} stopped: ${(e as Error).message}`,
    );
  }

  let lastMark = now();
  // Issue 562 review: a turn may have started during the install. The
  // watch's clock starts after this, so a long hold isn't a rollback.
  if (d.beforeRestart)
    await d
      .beforeRestart(() => {
        // At most once a minute: the hold passes every few seconds.
        if (now() - lastMark < 60_000) return;
        lastMark = now();
        state("installing");
      })
      .catch(() => {
        /* never stops the update: it restarts */
      });

  // Until the watch starts, a failure here is still this run's to roll back.
  const plan = path.join(dir, "plan.json");
  try {
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
      restartEnv: d.restartEnv ?? {},
      stateFile: updateStateFile(d.stateDir),
      restartMarker: d.note(`update Den ${from} → ${to}`),
    });
    state("watching");
    d.watch(script, plan);
  } catch (e) {
    return await rollBack(
      `the update to ${to} stopped before its watch started: ${(e as Error).message}`,
    );
  }
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

/**
 * Issue 562: whether `npm view <pkg>@<version> den --json` (that
 * version's package.json in npm's registry document) marks it a security
 * release: `den.security` is exactly true. No `den`, or anything else:
 * false. Never a tag name or the changelog.
 */
export function parseSecurityMark(out: string): boolean {
  const t = out.trim();
  if (!t) return false;
  try {
    const v = JSON.parse(t) as unknown;
    return (
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (v as { security?: unknown }).security === true
    );
  } catch {
    return false;
  }
}

/**
 * Issue 562: the security mark of `version` from npm's version data;
 * null when npm can't say (it counts as unmarked, and is asked again).
 */
export async function npmViewSecurity(
  npm: string[],
  pkg: string,
  version: string,
  cwd: string,
): Promise<boolean | null> {
  if (!UPDATE_SPEC_RE.test(version) || version === "latest") return null;
  // stdout only: a warning npm prints on stderr isn't the field.
  return new Promise((resolve) =>
    execFile(
      npm[0],
      [...npm.slice(1), "view", `${pkg}@${version}`, "den", "--json"],
      { cwd, timeout: 2 * 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout) =>
        resolve(err ? null : parseSecurityMark(String(stdout ?? ""))),
    ),
  );
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
