/**
 * Issue 563: a terminal host that outlived an update of Den.
 *
 * The terminal host (the session host, host.ts) is a process of its own,
 * so restarting the web server leaves it, and every agent and terminal it
 * runs, as they were. After an update it still runs the old version, with
 * the old native PTY module loaded. When the update changed that module,
 * npm moved the old one's folder aside and deleted it, and every new spawn
 * in that host fails ("posix_spawnp failed"), while running sessions carry
 * on.
 *
 * The update itself runs the old version's code, so the fix is the new
 * version's: when the web server starts it asks the host what it runs
 * (`hello`: its Den version, the native module it loaded). A host that
 * runs another version, loaded another module than the one installed, or
 * one no longer on disk, or is too old to say, is restarted the supported
 * way (what `<cli> sessions host --stop` does; the service manager, or
 * Den on demand, starts it again). Agents mid-turn are waited for, up to
 * sessions.host_restart_wait_seconds; then it restarts anyway (a host
 * that can't spawn is worse than an interrupted turn). The agents that
 * were running resume; open terminals end.
 */
import * as fs from "fs";
import type { HostClient } from "./client.js";
import { fileIdentity, type PtyModuleInfo } from "./pty.js";

/** What a running host says it runs (its `hello`). */
export interface HostRuns {
  /** undefined: a host too old to say. */
  den: string | null | undefined;
  pty: PtyModuleInfo | null;
}

/** What is installed now. */
export interface Installed {
  den: string | null;
  pty: PtyModuleInfo | null;
}

/**
 * Why a host that runs `h` is not current with what is installed, or null
 * when it is. An answer it can't give counts as different.
 */
export function hostStale(h: HostRuns, inst: Installed): string | null {
  if (h.den === undefined)
    return "the terminal host is from an older version that can't say what it runs";
  // null: a current host that couldn't read its own version: not, alone,
  // a reason (its module is still compared below).
  if (inst.den && h.den !== null && h.den !== inst.den)
    return `the terminal host runs ${h.den ?? "an unknown version"}, ${inst.den} is installed`;
  if (!h.pty) return null; // none loaded yet: it loads the installed one
  if (fileIdentity(h.pty.path) === null)
    return `the terminal module the host loaded (${h.pty.path}) is no longer on disk`;
  if (!inst.pty)
    return `the terminal host loaded ${h.pty.path}, and no terminal module is installed now`;
  if (h.pty.path !== inst.pty.path)
    return `the terminal host loaded ${h.pty.path}, ${inst.pty.path} is installed`;
  if (h.pty.version !== inst.pty.version)
    return `the terminal host loaded terminal module ${h.pty.version ?? "?"}, ${inst.pty.version ?? "?"} is installed`;
  if (h.pty.id && inst.pty.id && h.pty.id !== inst.pty.id)
    return `the terminal module at ${h.pty.path} was replaced after the host loaded it`;
  return null;
}

/** What a connected client's `hello` said. */
export function hostRuns(c: HostClient): HostRuns {
  return { den: c.hostDen, pty: c.hostPty };
}

/**
 * Stop the host `c` is connected to (`<cli> sessions host --stop`): ask it
 * to shut down, then wait (up to `waitMs`) for its socket to go. Its
 * sessions end. Closes `c`.
 */
export async function stopHost(
  c: HostClient,
  socket: string,
  waitMs = 5000,
): Promise<{ pid: number; ended: number }> {
  const pid = c.hostPid;
  const ended = (await c.list().catch(() => [])).filter(
    (s) => !s.exited,
  ).length;
  const closed = new Promise<void>((r) => c.once("close", () => r()));
  await c.shutdown();
  // The host drops every connection, then removes its socket.
  const deadline = Date.now() + waitMs;
  await Promise.race([closed, new Promise((r) => setTimeout(r, waitMs))]);
  while (fs.existsSync(socket) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  c.close();
  return { pid, ended };
}

export interface RefreshDeps {
  /** The host if one runs, else null (never starts one). */
  connectExisting(): Promise<HostClient | null>;
  /** The host, started when none answers (its service's job, or on demand). */
  connect(): Promise<HostClient>;
  socket: string;
  installed(): Installed;
  /** The agents running now (ids). */
  running(): Promise<string[]>;
  /** Of those, the ones mid-turn now. */
  busy(running: string[]): Promise<string[]>;
  /** sessions.host_restart_wait_seconds, in ms. */
  waitMs: number;
  pollMs?: number;
  /** Resume agent `id` (its conversation; a rotated one from its handoff). */
  resume(id: string): Promise<void>;
  log(line: string): void;
}

export type RefreshResult =
  | { did: "none" }
  | { did: "current" }
  | {
      did: "restarted";
      why: string;
      from: number;
      to: number;
      /** How long it waited for agents mid-turn. */
      waitedMs: number;
      /** Agents still mid-turn when the wait ran out (restarted anyway). */
      busy: string[];
      resumed: string[];
      failed: { agent: string; why: string }[];
      /** Terminals (not agents) that ended. */
      terminals: number;
    }
  | { did: "failed"; why: string };

/** Ask the running host what it runs; restart it when it isn't current. */
export async function refreshSessionHost(
  d: RefreshDeps,
): Promise<RefreshResult> {
  let c: HostClient | null;
  try {
    c = await d.connectExisting();
  } catch (e) {
    // A host that can't even say hello (another protocol): left as it is,
    // and said; doctor's row shows it.
    c = null;
    d.log(`terminal host: no answer to hello: ${(e as Error).message}`);
  }
  if (!c) return { did: "none" };
  const why = hostStale(hostRuns(c), d.installed());
  c.close();
  if (!why) return { did: "current" };
  d.log(`terminal host: ${why}: it restarts once no agent is mid-turn`);

  // The web restart's rule: never mid-turn, bounded by the setting.
  const started = Date.now();
  let running = await d.running().catch(() => [] as string[]);
  let busy = await d.busy(running).catch(() => running);
  while (busy.length && Date.now() - started < d.waitMs) {
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(d.pollMs ?? 5000, d.waitMs - (Date.now() - started)),
      ),
    );
    running = await d.running().catch(() => running);
    busy = await d.busy(running).catch(() => running);
  }
  const waitedMs = Date.now() - started;
  if (busy.length)
    d.log(
      `terminal host: agents still mid-turn after ${Math.round(waitedMs / 1000)} s (sessions.host_restart_wait_seconds): ${busy.join(", ")}; restarting anyway`,
    );

  let stopped: { pid: number; ended: number } = { pid: 0, ended: 0 };
  let to = 0;
  try {
    const now = await d.connectExisting();
    if (!now) return { did: "failed", why: "the terminal host went away" };
    stopped = await stopHost(now, d.socket);
    const back = await d.connect();
    to = back.hostPid;
    const after = hostStale(hostRuns(back), d.installed());
    back.close();
    if (after)
      return {
        did: "failed",
        why: `the terminal host came back still not current: ${after}`,
      };
  } catch (e) {
    return {
      did: "failed",
      why: `the terminal host didn't restart: ${(e as Error).message}`,
    };
  }
  const resumed: string[] = [];
  const failed: { agent: string; why: string }[] = [];
  for (const id of running)
    try {
      await d.resume(id);
      resumed.push(id);
    } catch (e) {
      failed.push({ agent: id, why: (e as Error).message });
    }
  return {
    did: "restarted",
    why,
    from: stopped.pid,
    to,
    waitedMs,
    busy,
    resumed,
    failed,
    terminals: Math.max(0, stopped.ended - running.length),
  };
}
