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
 *
 * Issue 597: another Den version alone is no reason. The host says the id
 * of its own code (host-code.ts) and the module it loaded; when both match
 * what is installed it is told the new version (`adopt`) and kept, with
 * its agents. An agent the restart cut mid-turn gets HOST_RESTART_NOTE as
 * its next input (sessions.host_restart_note).
 */
import * as fs from "fs";
import type { HostClient } from "./client.js";
import { fileIdentity, type PtyModuleInfo } from "./pty.js";
import type { SessionInfo } from "./types.js";

/**
 * Issue 597: the line an agent the restart cut mid-turn gets as its next
 * input, so it carries on by itself.
 */
export const HOST_RESTART_NOTE =
  "Den restarted while you were working; check your last step and carry on.";

/** What a running host says it runs (its `hello`). */
export interface HostRuns {
  /** undefined: a host too old to say. */
  den: string | null | undefined;
  /** Issue 597: its code's id; undefined (or left out): too old to say. */
  code?: string | null;
  pty: PtyModuleInfo | null;
}

/** What is installed now. */
export interface Installed {
  den: string | null;
  /** Issue 597: the installed host code's id (hostCodeId; null: unknown). */
  code: string | null;
  pty: PtyModuleInfo | null;
}

/** Issue 597: why a host must restart: its code, or its terminal module. */
export interface HostRestartNeed {
  restart: "code" | "module";
  why: string;
}

const short = (id: string | null | undefined): string =>
  id ? id.replace(/^sha256:/, "").slice(0, 12) : "unknown";

/**
 * Issue 597: whether a host that runs `h` must restart to be current with
 * what is installed, and why; null when it needn't (another Den version
 * alone is no reason). An answer it can't give counts as different.
 */
export function hostCheck(
  h: HostRuns,
  inst: Installed,
): HostRestartNeed | null {
  const code = (why: string): HostRestartNeed => ({ restart: "code", why });
  const mod = (why: string): HostRestartNeed => ({ restart: "module", why });
  if (h.den === undefined || h.code === undefined)
    return code(
      "the terminal host is from an older version that can't say what code it runs",
    );
  if (!h.code || !inst.code || h.code !== inst.code)
    return code(
      `the terminal host runs code ${short(h.code)}, ${short(inst.code)} is installed`,
    );
  if (!h.pty) return null; // none loaded yet: it loads the installed one
  if (fileIdentity(h.pty.path) === null)
    return mod(
      `the terminal module the host loaded (${h.pty.path}) is no longer on disk`,
    );
  if (!inst.pty)
    return mod(
      `the terminal host loaded ${h.pty.path}, and no terminal module is installed now`,
    );
  if (h.pty.path !== inst.pty.path)
    return mod(
      `the terminal host loaded ${h.pty.path}, ${inst.pty.path} is installed`,
    );
  if (h.pty.version !== inst.pty.version)
    return mod(
      `the terminal host loaded terminal module ${h.pty.version ?? "?"}, ${inst.pty.version ?? "?"} is installed`,
    );
  if (h.pty.id && inst.pty.id && h.pty.id !== inst.pty.id)
    return mod(
      `the terminal module at ${h.pty.path} was replaced after the host loaded it`,
    );
  return null;
}

/**
 * Why a host that runs `h` is not current with what is installed, or null
 * when it is (hostCheck's reason).
 */
export function hostStale(h: HostRuns, inst: Installed): string | null {
  return hostCheck(h, inst)?.why ?? null;
}

/** What a connected client's `hello` said. */
export function hostRuns(c: HostClient): HostRuns {
  return { den: c.hostDen, code: c.hostCode, pty: c.hostPty };
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
): Promise<{ pid: number; ended: number; live: SessionInfo[] }> {
  const pid = c.hostPid;
  // Issue 631: the sessions it ran at its stop, so no agent goes missing.
  const live = (await c.list().catch(() => [] as SessionInfo[])).filter(
    (s) => !s.exited,
  );
  const ended = live.length;
  const closed = new Promise<void>((r) => c.once("close", () => r()));
  await c.shutdown();
  // The host drops every connection, then removes its socket.
  const deadline = Date.now() + waitMs;
  await Promise.race([closed, new Promise((r) => setTimeout(r, waitMs))]);
  while (fs.existsSync(socket) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  c.close();
  return { pid, ended, live };
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
  /**
   * Issue 631: the agents the host's sessions at its stop belong to (by
   * their record's session, or their session's name), so an agent the
   * last look missed (mid-relaunch, say) is resumed too.
   */
  agentsOf?(sessions: SessionInfo[]): Promise<string[]>;
  /**
   * Issue 631: of the agents resumed, those whose session has ended since,
   * each with why ("exited (1) after its resume: <its last line>").
   */
  ended?(ids: readonly string[]): Promise<{ agent: string; why: string }[]>;
  /**
   * Issue 631: how long after the resumes to look for ones that ended
   * (sessions.host_restart_check_seconds, in ms). 0 or unset: no look.
   */
  checkMs?: number;
  /** sessions.host_restart_wait_seconds, in ms. */
  waitMs: number;
  /**
   * Issue 731: the host needs a restart and the wait for agents mid-turn
   * starts now (at most `waitMs`), so doctor can say Den is on it.
   */
  onWait?(w: { why: string; waitMs: number }): void;
  pollMs?: number;
  /**
   * Resume agent `id` (its conversation; a rotated one from its handoff).
   * Issue 597: `note`, when set, is its next input once it is back (an
   * agent the restart cut mid-turn).
   */
  resume(id: string, note: string | null): Promise<void>;
  /**
   * Issue 597: the line a cut agent gets (HOST_RESTART_NOTE), or null
   * (sessions.host_restart_note off). Default: the line.
   */
  cutNote?: string | null;
  log(line: string): void;
}

export type RefreshResult =
  | { did: "none" }
  | { did: "current" }
  /** Issue 597: another version, the same code and module: kept. */
  | { did: "kept"; from: string | null; to: string | null }
  | {
      did: "restarted";
      why: string;
      from: number;
      to: number;
      /** How long it waited for agents mid-turn. */
      waitedMs: number;
      /**
       * Agents still mid-turn when the wait ran out (restarted anyway):
       * the ones it cut (issue 597).
       */
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
  const runs = hostRuns(c);
  const inst = d.installed();
  const need = hostCheck(runs, inst);
  if (!need) {
    // Issue 597: its code and module are the installed ones: it is told
    // the new version and kept, with every agent in it.
    const from = runs.den ?? null;
    if (!inst.den || from === inst.den) {
      c.close();
      return { did: "current" };
    }
    try {
      await c.adopt(inst.den);
    } catch (e) {
      d.log(
        `terminal host: kept, but it didn't take the new version: ${(e as Error).message}`,
      );
    } finally {
      c.close();
    }
    return { did: "kept", from, to: inst.den };
  }
  c.close();
  const why = need.why;
  d.log(`terminal host: ${why}: it restarts once no agent is mid-turn`);
  try {
    d.onWait?.({ why, waitMs: d.waitMs });
  } catch {
    /* doctor's note is best effort: the restart goes on */
  }

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
      `terminal host: agents still mid-turn or running a background job they started after ${Math.round(waitedMs / 1000)} s (sessions.host_restart_wait_seconds): ${busy.join(", ")}; restarting anyway`,
    );

  let stopped: { pid: number; ended: number; live: SessionInfo[] } = {
    pid: 0,
    ended: 0,
    live: [],
  };
  let to = 0;
  // Issue 631: one more look right before the stop. An agent that wasn't
  // running at the last look (between the stop and the start of its
  // relaunch from a handoff) is on the list too: none goes missing.
  running = [...running];
  const add = (ids: readonly string[]) => {
    for (const id of ids) if (!running.includes(id)) running.push(id);
  };
  add(await d.running().catch(() => [] as string[]));
  try {
    const now = await d.connectExisting();
    if (!now) return { did: "failed", why: "the terminal host went away" };
    stopped = await stopHost(now, d.socket);
    // And every agent whose session the host still ran at its stop.
    if (d.agentsOf)
      add(await d.agentsOf(stopped.live).catch(() => [] as string[]));
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
  const note = d.cutNote === undefined ? HOST_RESTART_NOTE : d.cutNote;
  const cut = new Set(busy);
  for (const id of running)
    try {
      await d.resume(id, note && cut.has(id) ? note : null);
      resumed.push(id);
    } catch (e) {
      failed.push({ agent: id, why: (e as Error).message });
    }
  // Issue 631: a resume that started but didn't hold (the runtime exited
  // after its first moments: a conversation it couldn't continue) is a
  // failed one, with its reason, never a resumed one.
  if (d.ended && d.checkMs && resumed.length) {
    await new Promise((r) => setTimeout(r, d.checkMs));
    const gone = await d.ended([...resumed]).catch(() => []);
    for (const g of gone) {
      const i = resumed.indexOf(g.agent);
      if (i < 0) continue;
      resumed.splice(i, 1);
      failed.push(g);
    }
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
