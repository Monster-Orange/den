/**
 * Issue 500: after a verified update (the watch wrote "good" for this
 * version), a terminal host still on an older version with no shells
 * running is restarted on this one. With a shell running it is never
 * killed: the page and doctor say it runs an older version, and the
 * person restarts it when they're done (one click on Terminal).
 *
 *   not-updated  no verified update to this version
 *   none         no host runs (the next one starts on this version)
 *   current      the host runs this version already
 *   busy         older, with shells running: left alone
 *   stuck        it doesn't answer: left alone (doctor and Terminal say it)
 *   replaced     older and idle: stopped, and one of this version started
 */
import { readUpdateState } from "./den-update.js";
import {
  checkHost,
  hostIsOlder,
  restartHost,
} from "../../shared/sessions/host-check.js";

export type HostRefresh =
  | "not-updated"
  | "none"
  | "current"
  | "busy"
  | "stuck"
  | "replaced";

export async function refreshHostAfterUpdate(d: {
  stateDir: string;
  denVersion: string | undefined;
  socket: string;
  timeoutMs: number;
  /** Start a host of this version (spawned, or its launchd job). */
  start: () => Promise<void>;
  log: (line: string) => void;
}): Promise<HostRefresh> {
  const u = readUpdateState(d.stateDir);
  if (!d.denVersion || !u || u.state !== "good" || u.to !== d.denVersion)
    return "not-updated";
  const check = await checkHost({ socket: d.socket, timeoutMs: d.timeoutMs });
  if (check.state === "none") return "none";
  if (check.state === "stuck") {
    d.log(
      `  ⚠ the terminal host doesn't answer (${check.reason}): left running; Terminal and doctor say so`,
    );
    return "stuck";
  }
  if (!hostIsOlder(check.version, d.denVersion)) return "current";
  const was = check.version ? `v${check.version}` : "an older version";
  if (check.live > 0) {
    d.log(
      `  the terminal host runs ${was} with ${check.live} shell${check.live === 1 ? "" : "s"} running: left running until it is restarted`,
    );
    return "busy";
  }
  await restartHost({
    socket: d.socket,
    timeoutMs: d.timeoutMs,
    start: d.start,
  });
  d.log(
    `  restarted the idle terminal host (pid ${check.pid}, ${was}) on v${d.denVersion}`,
  );
  return "replaced";
}
