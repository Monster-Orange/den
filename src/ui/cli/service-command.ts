/**
 * `service install | status | print | uninstall`
 *
 * The web UI as a macOS launchd service, over Den's service/install.sh. The
 * label and log directory come from the org config's `web.service`
 * (readWebServiceConfig), with the script's own defaults, so a distribution
 * no longer wraps the script in its Makefile.
 *
 * `install` (which also restarts a running service) says the service is
 * running only once the web server answers /api/server-info with JSON: a
 * fresh server takes a few seconds to start, and answers empty until then.
 *
 * `install --plan` is read-only: it prints the plist install would write
 * (install.sh print), the label, the paths and whose server answers on the
 * port, and writes and loads nothing; exit 1 when that server is foreign.
 * `status` also names a foreign server on the port.
 *
 * D18: `install --mode login|always`. login: LaunchAgents in the desktop
 * session, stopped at logout. always: LaunchDaemons that run as you, kept
 * across logout (one sudo). Without --mode, the mode already installed
 * (else login): re-running install never changes it. Both modes also
 * install the session host as its own job, on Den's node copy
 * (`<stateDir>/bin/<cli>-sessions-host`, the path Full Disk Access is
 * granted to), and `<cli> sessions` then waits for that job instead of
 * starting a host of its own.
 *
 * D26: "running" means the server answering on the port is the job's own
 * process (its pid is launchd's). A plain `web up` server of this install
 * holding the port is stopped first; `status` says when one holds it.
 */
import {
  ownerGithubLine,
  recordOwnerGithub,
  type OwnerGithubResult,
} from "../../shared/owner-github.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getStateDir } from "../../shared/paths.js";
import {
  serviceJobState,
  type ServiceJob,
  type ServiceMode,
} from "./doctor-where.js";
import {
  readDenConfig,
  readWebServiceConfig,
  type DenConfig,
} from "../../shared/den-config.js";
import { readWebPort } from "../../shared/edge/config.js";
import { getDistRoot, getEngineRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import {
  classifyServerInfo,
  ForeignServerError,
  foreignServerMessage,
  identifyServer,
  ownServer,
  pickAnotherPortHint,
  type OwnServer,
  type ServerIdentity,
} from "./server-identity.js";

/** Runs a command with extra env vars; returns its exit code. */
export type ServiceRunner = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
) => number;

const SUBCOMMANDS = ["install", "status", "print", "uninstall"] as const;

/** The flags each subcommand takes; any other is refused before acting. */
const SUBCOMMAND_FLAGS: Record<(typeof SUBCOMMANDS)[number], string[]> = {
  install: ["--plan", "--mode"],
  status: [],
  print: [],
  uninstall: [],
};

const defaultRunner: ServiceRunner = (cmd, args, env) =>
  spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } })
    .status ?? 1;

/** How long `install` waits for the web server to answer. */
export const READY_TIMEOUT_MS = 30_000;

/**
 * Poll `url` until it answers 2xx with a JSON object, or `timeoutMs` passes.
 * Each attempt is bounded too, so a hung connection cannot outlast it. A
 * server that is not `own`'s (another distribution's, on the same port) is
 * never "running": that throws ForeignServerError at once.
 */
export async function waitForServerInfo(
  url: string,
  timeoutMs: number = READY_TIMEOUT_MS,
  intervalMs = 500,
  own: OwnServer = ownServer(),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(2_000, left)),
      });
      if (res.ok) {
        const body: unknown = JSON.parse(await res.text());
        if (body !== null && typeof body === "object") {
          const id = classifyServerInfo(body, own);
          if (id.kind === "foreign")
            throw new ForeignServerError(Number(new URL(url).port), id.who);
          return true;
        }
      }
    } catch (e) {
      if (e instanceof ForeignServerError) throw e;
      /* not up yet: refused, empty or partial body */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface ServiceDeps {
  run?: ServiceRunner;
  /** The state dir (default getStateDir()): Den's node copy, the host job file. */
  stateDir?: string;
  /** D18: the job installed for a label, if any (default: plists + launchctl). */
  job?: (label: string) => ServiceJob | null;
  /** D26: the pid launchd runs a job as, or null (default: launchctl print). */
  jobPid?: (job: ServiceJob, label: string) => number | null;
  /** D26: stop a plain server of this install (default: SIGTERM, wait). */
  stopPlain?: (pid: number, port: number) => Promise<boolean>;
  /** D17: record web.owner_github (default: from gh, unless `run` is a test's). */
  recordOwner?: () => OwnerGithubResult;
  config?: DenConfig;
  distRoot?: string;
  engineRoot?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The web UI port (default: config web.port). */
  webPort?: number;
  /**
   * Readiness poller (default: waitForServerInfo). Throws
   * ForeignServerError when another distribution's server answers.
   */
  waitReady?: (
    url: string,
    timeoutMs: number,
    own: OwnServer,
  ) => Promise<boolean>;
  log?: (line: string) => void;
  /** Whose server answers on a port (default: identifyServer). */
  identify?: (port: number, own: OwnServer) => Promise<ServerIdentity>;
}

/** One line on whose server answers on `port`. */
export function identityLine(port: number, id: ServerIdentity): string {
  switch (id.kind) {
    case "none":
      return `port ${port}: free (nothing listening)`;
    case "unresponsive":
      return `port ${port}: something accepted the connection but did not answer`;
    case "ours":
      return `port ${port}: this distribution's server${id.version ? ` (Den ${id.version})` : ""}${id.pid ? `, pid ${id.pid}` : ""}`;
    case "foreign":
      return `${foreignServerMessage(port, id.who)}; not this distribution's server`;
  }
}

/** D18: the session host's job label: the web label's `.web` → `.sessions`. */
export function hostLabel(label: string): string {
  return `${label.replace(/\.web$/, "")}.sessions`;
}

/** D18: Den's node copy for the session host, the path Full Disk Access names. */
export function hostExePath(stateDir: string, cli: string): string {
  return path.join(stateDir, "bin", `${cli}-sessions-host`);
}

/**
 * D18: the file that says the session host runs as a launchd job
 * (`<cli> sessions` waits for it instead of starting one).
 */
export function hostJobFile(stateDir: string): string {
  return path.join(stateDir, "sessions-host-job.json");
}

/** `--mode <m>` / `--mode=<m>` from install's args; undefined when absent. */
function modeArg(args: string[]): ServiceMode | undefined {
  let v: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") v = args[i + 1];
    else if (args[i].startsWith("--mode=")) v = args[i].slice(7);
  }
  if (v === undefined) return undefined;
  if (v === "login" || v === "always") return v;
  throw new Error(`service install --mode takes login or always, not "${v}"`);
}

/** Install's args without `--mode <m>`, for the unknown-argument check. */
function withoutMode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") i++;
    else if (!args[i].startsWith("--mode=")) out.push(args[i]);
  }
  return out;
}

function defaultJobPid(job: ServiceJob, label: string): number | null {
  const r = spawnSync("launchctl", ["print", `${job.domain}/${label}`], {
    encoding: "utf-8",
    timeout: 3000,
  });
  if (r.status !== 0) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.stdout ?? "");
  return m ? Number(m[1]) : null;
}

async function defaultStopPlain(pid: number, port: number): Promise<boolean> {
  const { killWebProcess } = await import("./web-command.js");
  killWebProcess(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  void port;
  return false;
}

/** Run `service <sub>`; returns the exit code. */
export async function cmdService(
  args: string[],
  deps: ServiceDeps = {},
): Promise<number> {
  const sub = args[0] as (typeof SUBCOMMANDS)[number] | undefined;
  if (!(SUBCOMMANDS as readonly string[]).includes(sub ?? ""))
    throw new Error(
      `${sub ? `Unknown service command "${sub}". ` : ""}Use: ${SUBCOMMANDS.join(" | ")}`,
    );
  // A typo'd --plan must not install for real.
  const extra = (
    sub === "install" ? withoutMode(args.slice(1)) : args.slice(1)
  ).filter((a) => !SUBCOMMAND_FLAGS[sub!].includes(a));
  if (extra.length)
    throw new Error(
      `service ${sub}: unknown argument${extra.length > 1 ? "s" : ""} ${extra.join(" ")}` +
        (SUBCOMMAND_FLAGS[sub!].length
          ? ` (takes ${SUBCOMMAND_FLAGS[sub!].join(", ")})`
          : ""),
    );
  const plan = sub === "install" && args.includes("--plan");
  const askedMode = sub === "install" ? modeArg(args) : undefined;
  // print (and install --plan) only write the plist to stdout; the rest
  // talk to launchd.
  if (
    sub !== "print" &&
    !plan &&
    (deps.platform ?? process.platform) !== "darwin"
  )
    throw new Error(
      "the web UI service is a launchd LaunchAgent: macOS only (print works anywhere)",
    );
  const distRoot = deps.distRoot ?? getDistRoot();
  const { label, logs } = readWebServiceConfig(
    deps.config ?? readDenConfig(),
    distRoot,
    deps.home ?? os.homedir(),
  );
  const script = path.join(
    deps.engineRoot ?? getEngineRoot(),
    "service",
    "install.sh",
  );
  const home = deps.home ?? os.homedir();
  const jobOf =
    deps.job ??
    ((l: string) => serviceJobState(l, home, process.getuid?.() ?? 0));
  const installed = jobOf(label);
  // D18: without --mode, the mode it has (re-running install keeps it).
  const mode: ServiceMode = askedMode ?? installed?.mode ?? "login";
  const stateDir = deps.stateDir ?? getStateDir();
  const env: Record<string, string> = {
    DEN_ROOT: distRoot,
    DEN_SERVICE_LABEL: label,
    DEN_SERVICE_LOGS: logs,
    ...(sub === "install" || sub === "print"
      ? {
          DEN_SERVICE_MODE: mode,
          DEN_SERVICE_HOST_EXE: hostExePath(stateDir, product().cli),
        }
      : {}),
  };
  const run = deps.run ?? defaultRunner;
  const log = deps.log ?? ((l: string) => console.log(l));
  const port = deps.webPort ?? readWebPort(distRoot);
  const own: OwnServer = { root: distRoot, product: product().name };
  const identify =
    deps.identify ?? ((p: number, o: OwnServer) => identifyServer(p, o));

  const jobPid = deps.jobPid ?? defaultJobPid;
  if (plan) {
    const dir =
      mode === "always"
        ? "/Library/LaunchDaemons"
        : path.join(home, "Library", "LaunchAgents");
    log(`service install --plan (read-only: nothing is written or loaded)`);
    log(
      `  mode:    ${mode}${mode === "always" ? " (LaunchDaemons running as you: kept across logout; one sudo)" : " (LaunchAgents: stop at logout)"}`,
    );
    log(`  label:   ${label}`);
    log(`  plist:   ${path.join(dir, `${label}.plist`)}`);
    log(
      `  host:    ${hostLabel(label)} on ${hostExePath(stateDir, product().cli)} (grant this path Full Disk Access for protected folders)`,
    );
    log(`  logs:    ${path.join(logs, "web.log")}`);
    log(`  root:    ${distRoot}`);
    log(`  engine:  ${path.dirname(path.dirname(script))}`);
    log(`  url:     http://localhost:${port}`);
    const id = await identify(port, own);
    log(`  server:  ${identityLine(port, id)}`);
    // D26: what install does with a plain server of this install.
    if (
      id.kind === "ours" &&
      id.pid &&
      id.pid !== (installed ? jobPid(installed, label) : null)
    )
      log(
        `           install stops this plain server (pid ${id.pid}) first; the service runs it then`,
      );
    log(`  plist it would write:`);
    // install.sh print writes the plist to stdout only.
    const code = run("bash", [script, "print"], env);
    if (code !== 0) return code;
    if (id.kind === "foreign") {
      log(`✗ install would refuse this port: ${pickAnotherPortHint()}`);
      return 1;
    }
    return 0;
  }

  // D26: a plain `web up` server of this install on the port would answer
  // for the job (which then crash-loops on the taken port): stop it first.
  if (sub === "install") {
    const id = await identify(port, own);
    const pid = id.kind === "ours" ? id.pid : undefined;
    const theJob = installed ? jobPid(installed, label) : null;
    if (pid && pid !== theJob) {
      const stopped = await (deps.stopPlain ?? defaultStopPlain)(pid, port);
      if (!stopped) {
        log(
          `✗ a plain server of this install (pid ${pid}) holds port ${port} and did not stop: ${product().cli} web down, then service install again`,
        );
        return 1;
      }
      log(
        `… stopped the plain server of this install (pid ${pid}) on port ${port}: the service runs it now`,
      );
    }
  }

  // D17: whoever installs it can connect their GitHub account from any
  // browser (web.owner_github, from gh), before the server reads it.
  if (sub === "install") {
    const rec =
      deps.recordOwner ??
      (deps.run ? () => ({ state: "linked" as const }) : recordOwnerGithub);
    const line = ownerGithubLine(rec(), product().cli);
    if (line) log(line);
  }
  const code = run("bash", [script, sub!], {
    ...env,
    // The script then leaves saying "running" to us (after the poll below).
    ...(sub === "install" ? { DEN_SERVICE_READY_CHECK: "external" } : {}),
  });
  if (sub === "uninstall" && code === 0)
    fs.rmSync(hostJobFile(stateDir), { force: true });
  if (sub === "status") {
    const id = await identify(port, own);
    if (id.kind === "foreign") log(`✗ ${identityLine(port, id)}`);
    // D26: the server on the port is the job's, or say whose it is.
    if (id.kind === "ours" && id.pid && installed) {
      const theJob = jobPid(installed, label);
      if (theJob !== id.pid) {
        log(
          `✗ port ${port} is served by pid ${id.pid}, not the service (${theJob ? `pid ${theJob}` : "not running"}): a plain server of this install holds it. ${product().cli} web down, then ${product().cli} service install`,
        );
        return 1;
      }
    }
    return code;
  }
  if (sub !== "install" || code !== 0) return code;
  // D18: `<cli> sessions` waits for the host job instead of starting one.
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      hostJobFile(stateDir),
      JSON.stringify({ label: hostLabel(label), mode }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* sessions then start a host of their own, as before */
  }

  const url = `http://localhost:${port}/api/server-info`;
  const waitReady =
    deps.waitReady ??
    ((u: string, t: number, o: OwnServer) => waitForServerInfo(u, t, 500, o));
  let ready: boolean;
  try {
    ready = await waitReady(url, READY_TIMEOUT_MS, own);
  } catch (e) {
    if (!(e instanceof ForeignServerError)) throw e;
    log(
      `✗ ${label} installed, but ${foreignServerMessage(e.port, e.who)}, ` +
        `so it cannot serve there: ${pickAnotherPortHint()}`,
    );
    return 1;
  }
  if (ready) {
    // D26: the answer must come from the job itself, not from another
    // process of this install on the port (the job then crash-loops).
    const job = jobOf(label);
    const id = await identify(port, own);
    const served = id.kind === "ours" ? id.pid : undefined;
    const theJob = job ? jobPid(job, label) : null;
    if (job && served && theJob !== served) {
      log(
        `✗ ${label} installed, but port ${port} is served by pid ${served}, not the job (${theJob ? `pid ${theJob}` : "not running"}): ${product().cli} web down, then ${product().cli} service install`,
      );
      return 1;
    }
    log(
      `✓ ${label} running (${mode}) at http://localhost:${port} (logs: ${path.join(logs, "web.log")})`,
    );
    return 0;
  }
  log(
    `✗ ${label} installed but not answering yet: check ${logs} ` +
      `(${url} gave no JSON within ${READY_TIMEOUT_MS / 1000}s)`,
  );
  return 1;
}
