/**
 * D18/D20: doctor's "where it runs" rows (macOS only).
 *
 *   server        the web server's launchd session (/api/server-info)
 *   session host  the session host's (its hello), where every agent runs
 *   full disk access  whether the host (and so every agent) has it, and
 *                 the executable to grant it to: Den's node copy, never the
 *                 shared node
 *   service       the installed launchd job: always (a LaunchDaemon, kept
 *                 across logout) or login (a LaunchAgent in the desktop
 *                 session), and "plist present, job not loaded" with the
 *                 bootstrap that loads it
 *
 * A process in the desktop session (Aqua) stops at logout: a warning with
 * the fix. None of these fails doctor.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  ALWAYS_UNPROVEN,
  endsAtLogout,
  sessionWarning,
} from "../../shared/launchd-session.js";

export type ServiceMode = "always" | "login";

export interface ServiceJob {
  /** unknown: launchctl could not be asked. */
  state: "loaded" | "not-loaded" | "unknown";
  mode: ServiceMode;
  plist: string;
  domain: string;
}

export interface WhereDeps {
  cli: string;
  platform: NodeJS.Platform;
  /** The web server's launchd session; null when it does not answer. */
  server: () => Promise<{ launchd?: string | null } | null>;
  /** The running session host's; null when none runs. */
  host: () => Promise<{
    launchd: string | null;
    /** The pid that answers on the socket. */
    pid?: number;
    /** When it started (ISO). */
    startedAt?: string;
    access?: { exe: string; fullDiskAccess: boolean | null } | null;
  } | null>;
  service: () => ServiceJob | null;
  /** The service's own host job's pid (it may stand by), or null. */
  hostJob?: () => number | null;
}

export interface WhereRow {
  what: "server" | "session host" | "full disk access" | "service";
  session: string;
  /** info: as chosen, worth knowing (login mode ends at logout). */
  status: "ok" | "info" | "warn";
  detail?: string;
}

function sessionRow(
  what: "server" | "session host",
  launchd: string | null | undefined,
  cli: string,
  loginChosen = false,
): WhereRow {
  const session = launchd || "unknown";
  return {
    what,
    session,
    // The service installed in login mode: ending at logout is what was
    // chosen (the default), so it is said, not warned about.
    status: endsAtLogout(launchd) ? (loginChosen ? "info" : "warn") : "ok",
    ...(sessionWarning(launchd, cli, what)
      ? { detail: sessionWarning(launchd, cli, what)! }
      : {}),
  };
}

export async function whereRows(d: WhereDeps): Promise<WhereRow[]> {
  if (d.platform !== "darwin") return [];
  const rows: WhereRow[] = [];
  const svc = d.service();
  const loginChosen = svc?.mode === "login" && svc.state !== "not-loaded";
  const server = await d.server().catch(() => null);
  rows.push(
    server
      ? sessionRow("server", server.launchd, d.cli, loginChosen)
      : {
          // Not started yet is not a problem (a fresh install).
          what: "server",
          session: "not running",
          status: "ok",
          detail: `start it: ${d.cli} web up, or ${d.cli} service install`,
        },
  );
  const host = await d.host().catch(() => null);
  const jobPid = host ? (d.hostJob?.() ?? null) : null;
  // The service's host stands by while another host holds the socket, and
  // takes over when that one exits: nothing to do.
  const standsBy =
    jobPid !== null && host?.pid !== undefined && jobPid !== host.pid;
  const since = host?.startedAt ? `, since ${host.startedAt.slice(0, 10)}` : "";
  const older = `an older session host (pid ${host?.pid ?? "?"}${since})`;
  const switchNow = `To switch now (ends running terminals and agents): ${d.cli} sessions host --stop`;
  rows.push(
    host && standsBy
      ? {
          what: "session host",
          session: host.launchd || `older host (pid ${host.pid})`,
          status: "info",
          detail: `${older} is serving; the service's host (pid ${jobPid}) takes over when it exits. Nothing to do. ${switchNow}`,
        }
      : host && !host.launchd
        ? {
            // An older host and no service host behind it: what it lacks.
            what: "session host",
            session: `unknown (older host${host.pid ? `, pid ${host.pid}` : ""})`,
            status: "warn",
            detail: `${older} can't say where it runs, so whether its terminals and agents stop at logout is unknown. It is replaced the next time it exits. ${switchNow}`,
          }
        : host
          ? sessionRow("session host", host.launchd, d.cli, loginChosen)
          : {
              what: "session host",
              session: "not running",
              status: "ok",
              detail: "it starts when the first terminal or agent does",
            },
  );
  const fda = host?.access;
  if (fda && fda.fullDiskAccess !== null) {
    const own = /-sessions-host$/.test(fda.exe);
    rows.push(
      fda.fullDiskAccess
        ? {
            what: "full disk access",
            session: "granted",
            status: "ok",
            detail: `to ${fda.exe}`,
          }
        : {
            what: "full disk access",
            session: "not granted",
            status: "warn",
            detail: own
              ? `agents can't open protected folders (other volumes, Desktop, Documents): System Settings → Privacy & Security → Full Disk Access → + → ${fda.exe}, then ${d.cli} sessions host --stop (it restarts with the grant)`
              : `agents can't open protected folders. The host runs the shared node (${fda.exe}): ${d.cli} service install gives it its own copy to grant, so the grant never goes to every node program`,
          },
    );
  }
  if (!svc)
    rows.push({
      what: "service",
      session: "not installed",
      status: "ok",
      detail: `${d.cli} service install (login, the default; --mode always is opt-in and ${ALWAYS_UNPROVEN})`,
    });
  else if (svc.state === "not-loaded")
    rows.push({
      what: "service",
      session: `${svc.mode} (${svc.domain})`,
      status: "warn",
      detail: `plist present, job not loaded: ${svc.domain === "system" ? "sudo " : ""}launchctl bootstrap ${svc.domain} ${svc.plist}`,
    });
  else
    rows.push({
      what: "service",
      session: `${svc.mode} (${svc.domain})`,
      status: "ok",
      ...(svc.state === "unknown"
        ? { detail: "launchctl could not be asked whether it is loaded" }
        : svc.mode === "always"
          ? { detail: `opt-in: ${ALWAYS_UNPROVEN}` }
          : {}),
    });
  return rows;
}

/** The pid launchd runs `<domain>/<label>` as, or null (launchctl print). */
export function launchdJobPid(domain: string, label: string): number | null {
  const r = spawnSync("launchctl", ["print", `${domain}/${label}`], {
    encoding: "utf-8",
    timeout: 3000,
  });
  if (r.status !== 0) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.stdout ?? "");
  return m ? Number(m[1]) : null;
}

export interface JobProbe {
  exists: (p: string) => boolean;
  /** `launchctl print <domain>/<label>`'s exit status (127: no launchctl). */
  print: (target: string) => number | null;
}

const realProbe: JobProbe = {
  exists: (p) => fs.existsSync(p),
  print: (target) =>
    spawnSync("launchctl", ["print", target], {
      stdio: "ignore",
      timeout: 3000,
    }).status,
};

/**
 * The installed service job for `label`: the LaunchDaemon (always) when
 * its plist exists, else the LaunchAgent (login); null when neither does.
 */
export function serviceJobState(
  label: string,
  home: string,
  uid: number,
  probe: JobProbe = realProbe,
): ServiceJob | null {
  const daemon = path.join("/Library/LaunchDaemons", `${label}.plist`);
  const agent = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const found: [ServiceMode, string, string] | null = probe.exists(daemon)
    ? ["always", daemon, "system"]
    : probe.exists(agent)
      ? ["login", agent, `gui/${uid}`]
      : null;
  if (!found) return null;
  const [mode, plist, domain] = found;
  const code = probe.print(`${domain}/${label}`);
  const state =
    code === 0
      ? "loaded"
      : code === null || code === 127
        ? "unknown"
        : "not-loaded";
  return { state, mode, plist, domain };
}

/** The rows as doctor prints them, under a heading. */
export function formatWhere(rows: WhereRow[], title: string): string[] {
  if (!rows.length) return [];
  const lines = ["", `${title} doctor: where it runs`, ""];
  const w = Math.max(...rows.map((r) => r.session.length));
  for (const r of rows) {
    const mark = r.status === "ok" ? "✓" : r.status === "info" ? "ℹ" : "⚠";
    lines.push(`  ${r.what.padEnd(16)}  ${r.session.padEnd(w)}  ${mark}`);
    if (r.detail)
      lines.push(`    ${r.status === "warn" ? "⚠ " : ""}${r.detail}`);
  }
  return lines;
}
