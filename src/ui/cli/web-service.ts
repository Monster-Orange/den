/**
 * `web up | down | restart` when this install's web server runs as a
 * launchd service (`<cli> service install`).
 *
 * Before, `web restart` stopped the job's server and started a plain one.
 * launchd brought the job straight back (KeepAlive), it took the port, and
 * the plain server died seconds after "OK ... started". Now, with the
 * service installed and the command on its port:
 *
 *   - restart: `launchctl kickstart -k`, then the job's new pid and the
 *     service's log;
 *   - up: a job that is not answering is started the same way;
 *   - down: refused, because launchd would only start it again; it names
 *     `<cli> service uninstall`.
 *
 * In always mode the job is in the system domain: kickstart there needs
 * sudo, so the command is printed for the person to run, never run here.
 */
import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import {
  readDenConfig,
  readWebServiceConfig,
} from "../../shared/den-config.js";
import { readWebPort } from "../../shared/edge/config.js";
import { getDistRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { serviceJobState, type ServiceJob } from "./doctor-where.js";

export interface WebService {
  label: string;
  /** The service's web.log. */
  log: string;
  job: ServiceJob;
}

export interface WebServiceDeps {
  /** The installed service for this install's port, or null. */
  service?: (port: number) => WebService | null;
  /** launchctl kickstart [-k] <domain>/<label>; its exit code. */
  kickstart?: (target: string, kill: boolean) => number;
  /** The pid launchd runs the job as, or null. */
  jobPid?: (svc: WebService) => number | null;
  /** Until the job's server answers as this install's (true) or time runs out. */
  waitReady?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
  /** Between pid checks while the job comes back (default 250 ms). */
  pollMs?: number;
  /** How long to wait for the job's new pid (default 30 s). */
  pidTimeoutMs?: number;
}

export type WebServiceResult =
  | { handled: false }
  | { handled: true; code: number; pid?: number };

function defaultService(port: number): WebService | null {
  if (process.platform !== "darwin") return null;
  const distRoot = getDistRoot();
  // The service serves this install's configured port only.
  if (port !== readWebPort(distRoot)) return null;
  const { label, logs } = readWebServiceConfig(
    readDenConfig(),
    distRoot,
    os.homedir(),
  );
  const job = serviceJobState(label, os.homedir(), process.getuid?.() ?? 0);
  if (!job || job.state !== "loaded") return null;
  return { label, log: path.join(logs, "web.log"), job };
}

function defaultKickstart(target: string, kill: boolean): number {
  return (
    spawnSync("launchctl", ["kickstart", ...(kill ? ["-k"] : []), target], {
      stdio: "ignore",
      timeout: 10_000,
    }).status ?? 1
  );
}

function defaultJobPid(svc: WebService): number | null {
  const r = spawnSync(
    "launchctl",
    ["print", `${svc.job.domain}/${svc.label}`],
    { encoding: "utf-8", timeout: 3000 },
  );
  if (r.status !== 0) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.stdout ?? "");
  return m ? Number(m[1]) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What `web <action>` does when the service is installed. `answering`:
 * this install's server already answers on the port. Not handled: no
 * service (or another port), and `up` while it answers.
 */
export async function webServiceAction(
  action: "up" | "down" | "restart" | "open",
  port: number,
  answering: boolean,
  waitReadyDefault: (port: number) => Promise<boolean>,
  deps: WebServiceDeps = {},
): Promise<WebServiceResult> {
  if (action === "open") return { handled: false };
  const svc = (deps.service ?? defaultService)(port);
  if (!svc) return { handled: false };
  if (action === "up" && answering) return { handled: false };
  const log = deps.log ?? ((l: string) => console.log(l));
  const { cli, title } = product();
  const target = `${svc.job.domain}/${svc.label}`;

  if (action === "down") {
    log(
      `✗ ${title} web runs as the service ${svc.label} (${svc.job.mode}): stopping it only makes launchd start it again.`,
    );
    log(`  To stop it for good: ${cli} service uninstall`);
    log(`  To restart it: ${cli} web restart`);
    return { handled: true, code: 1 };
  }

  if (svc.job.mode === "always") {
    log(
      `${title} web runs as the service ${svc.label} (always). Restarting it needs sudo:`,
    );
    log(`  sudo launchctl kickstart -k ${target}`);
    return { handled: true, code: 1 };
  }

  const jobPid = deps.jobPid ?? defaultJobPid;
  const before = jobPid(svc);
  const code = (deps.kickstart ?? defaultKickstart)(target, true);
  if (code !== 0) {
    log(`✗ launchctl kickstart -k ${target} failed (exit ${code})`);
    log(`  See ${svc.log}`);
    return { handled: true, code: 1 };
  }
  // A new pid, then the server answering.
  const deadline = Date.now() + (deps.pidTimeoutMs ?? 30_000);
  let pid = jobPid(svc);
  while ((pid === null || pid === before) && Date.now() < deadline) {
    await sleep(deps.pollMs ?? 250);
    pid = jobPid(svc);
  }
  const ready =
    pid !== null &&
    pid !== before &&
    (await (deps.waitReady ?? waitReadyDefault)(port));
  if (!ready) {
    log(`✗ the service ${svc.label} did not come back. See ${svc.log}`);
    return { handled: true, code: 1 };
  }
  log(
    `OK ${title} web ${action === "up" ? "started" : "restarted"} by its service ${svc.label} (pid ${pid})`,
  );
  log(`  Log: ${svc.log}`);
  return { handled: true, code: 0, pid: pid! };
}
