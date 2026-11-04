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
 */
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

/** Runs a command with extra env vars; returns its exit code. */
export type ServiceRunner = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
) => number;

const SUBCOMMANDS = ["install", "status", "print", "uninstall"] as const;

const defaultRunner: ServiceRunner = (cmd, args, env) =>
  spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } })
    .status ?? 1;

/** How long `install` waits for the web server to answer. */
export const READY_TIMEOUT_MS = 30_000;

/**
 * Poll `url` until it answers 2xx with a JSON object, or `timeoutMs` passes.
 * Each attempt is bounded too, so a hung connection cannot outlast it.
 */
export async function waitForServerInfo(
  url: string,
  timeoutMs: number = READY_TIMEOUT_MS,
  intervalMs = 500,
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
        if (body !== null && typeof body === "object") return true;
      }
    } catch {
      /* not up yet: refused, empty or partial body */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface ServiceDeps {
  run?: ServiceRunner;
  config?: DenConfig;
  distRoot?: string;
  engineRoot?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The web UI port (default: config web.port). */
  webPort?: number;
  /** Readiness poller (default: waitForServerInfo). */
  waitReady?: (url: string, timeoutMs: number) => Promise<boolean>;
  log?: (line: string) => void;
}

/** Run `service <sub>`; returns the exit code. */
export async function cmdService(
  args: string[],
  deps: ServiceDeps = {},
): Promise<number> {
  const sub = args[0];
  if (!(SUBCOMMANDS as readonly string[]).includes(sub ?? ""))
    throw new Error(
      `${sub ? `Unknown service command "${sub}". ` : ""}Use: ${SUBCOMMANDS.join(" | ")}`,
    );
  // print only writes the plist; the rest talk to launchd.
  if (sub !== "print" && (deps.platform ?? process.platform) !== "darwin")
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
  const code = (deps.run ?? defaultRunner)("bash", [script, sub!], {
    DEN_ROOT: distRoot,
    DEN_SERVICE_LABEL: label,
    DEN_SERVICE_LOGS: logs,
    // The script then leaves saying "running" to us (after the poll below).
    ...(sub === "install" ? { DEN_SERVICE_READY_CHECK: "external" } : {}),
  });
  if (sub !== "install" || code !== 0) return code;

  const log = deps.log ?? ((l: string) => console.log(l));
  const port = deps.webPort ?? readWebPort(distRoot);
  const url = `http://localhost:${port}/api/server-info`;
  if (await (deps.waitReady ?? waitForServerInfo)(url, READY_TIMEOUT_MS)) {
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
