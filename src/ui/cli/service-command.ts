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
 */
import {
  ownerGithubLine,
  recordOwnerGithub,
  type OwnerGithubResult,
} from "../../shared/owner-github.js";
import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
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
  install: ["--plan"],
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
  const extra = args
    .slice(1)
    .filter((a) => !SUBCOMMAND_FLAGS[sub!].includes(a));
  if (extra.length)
    throw new Error(
      `service ${sub}: unknown argument${extra.length > 1 ? "s" : ""} ${extra.join(" ")}` +
        (SUBCOMMAND_FLAGS[sub!].length
          ? ` (takes ${SUBCOMMAND_FLAGS[sub!].join(", ")})`
          : ""),
    );
  const plan = sub === "install" && args.includes("--plan");
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
  const env = {
    DEN_ROOT: distRoot,
    DEN_SERVICE_LABEL: label,
    DEN_SERVICE_LOGS: logs,
  };
  const run = deps.run ?? defaultRunner;
  const log = deps.log ?? ((l: string) => console.log(l));
  const port = deps.webPort ?? readWebPort(distRoot);
  const own: OwnServer = { root: distRoot, product: product().name };
  const identify =
    deps.identify ?? ((p: number, o: OwnServer) => identifyServer(p, o));

  if (plan) {
    const home = deps.home ?? os.homedir();
    log(`service install --plan (read-only: nothing is written or loaded)`);
    log(`  label:   ${label}`);
    log(
      `  plist:   ${path.join(home, "Library", "LaunchAgents", `${label}.plist`)}`,
    );
    log(`  logs:    ${path.join(logs, "web.log")}`);
    log(`  root:    ${distRoot}`);
    log(`  engine:  ${path.dirname(path.dirname(script))}`);
    log(`  url:     http://localhost:${port}`);
    const id = await identify(port, own);
    log(`  server:  ${identityLine(port, id)}`);
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
  if (sub === "status") {
    const id = await identify(port, own);
    if (id.kind === "foreign") log(`✗ ${identityLine(port, id)}`);
    return code;
  }
  if (sub !== "install" || code !== 0) return code;

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
    log(
      `✓ ${label} running at http://localhost:${port} (logs: ${path.join(logs, "web.log")})`,
    );
    return 0;
  }
  log(
    `✗ ${label} installed but not answering yet: check ${logs} ` +
      `(${url} gave no JSON within ${READY_TIMEOUT_MS / 1000}s)`,
  );
  return 1;
}
