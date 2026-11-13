/**
 * SRV-1a: the server agent restarts its own Den and carries on.
 *
 * `den_restart` is a held write (approval-routes.ts): with
 * `server_agent.self_update: ask` (the default) the person allows it; with
 * auto, the server agent's own ask runs at once. Its run leaves a marker
 * in the state dir (who asked, why, the version and pid it left), then
 * restarts through the same path as the browser's Restart Den (D64).
 * Sessions outlive the server, so every agent keeps its session.
 *
 * The new server takes the marker at start. Once the agent that asked is
 * at its prompt, Den types "Server is back on <version> (pid …)" into its
 * session, so its turn or plan carries on in the same conversation. Each
 * step is an audit row: the ask and the Allow (approval-routes.ts), the
 * restart, and the return.
 */
import * as fs from "fs";
import * as path from "path";

export interface RestartMarker {
  /** The approval it ran for. */
  id: string;
  reason: string;
  /** The agent that asked (its id), told when the server is back. */
  agent?: string;
  /** Who allowed it: the person, or the setting (never a session key). */
  allowed?: "person" | "auto";
  fromVersion: string;
  fromPid: number;
  at: string;
  /** SRV-1b: den_update's watch rolled back; `reason` says why. */
  rolledBack?: boolean;
}

/** A marker older than this is a restart that never came back: ignored. */
export const MARKER_MAX_AGE_MS = 24 * 60 * 60_000;

export function restartMarkerPath(stateDir: string): string {
  return path.join(stateDir, "server-agent", "restart.json");
}

/** Leave the marker the next server takes (0600, in a 0700 folder). */
export function writeRestartMarker(stateDir: string, m: RestartMarker): void {
  const p = restartMarkerPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * The marker a restart left, removed as it is read (it is told once).
 * Null: none, unreadable, or older than MARKER_MAX_AGE_MS.
 */
export function takeRestartMarker(
  stateDir: string,
  now: number = Date.now(),
): RestartMarker | null {
  const p = restartMarkerPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    /* gone already: still told once, by whoever read it */
  }
  try {
    const m = JSON.parse(raw) as Partial<RestartMarker>;
    if (
      typeof m.id !== "string" ||
      typeof m.reason !== "string" ||
      typeof m.at !== "string"
    )
      return null;
    const at = Date.parse(m.at);
    if (!Number.isFinite(at) || now - at > MARKER_MAX_AGE_MS) return null;
    return {
      id: m.id,
      reason: m.reason,
      ...(typeof m.agent === "string" && m.agent ? { agent: m.agent } : {}),
      ...(m.allowed === "auto" || m.allowed === "person"
        ? { allowed: m.allowed }
        : {}),
      fromVersion: String(m.fromVersion ?? "?"),
      fromPid: Number(m.fromPid) || 0,
      at: m.at,
      ...(m.rolledBack === true ? { rolledBack: true } : {}),
    };
  } catch {
    return null;
  }
}

/** What Den types into the agent's session when the new server is up. */
export function backMessage(
  m: RestartMarker,
  version: string,
  pid: number,
): string {
  if (m.rolledBack)
    return (
      `Server is back on ${version} (pid ${pid}), rolled back: ${m.reason}. ` + // words-ok: SRV-1 spec's own line, typed to the agent
      "Your update didn't take: commit no pin change, and tell your person why."
    );
  const was = m.fromVersion === version ? "" : ` (it was ${m.fromVersion})`;
  return (
    `Server is back on ${version} (pid ${pid})${was}. ` + // words-ok: SRV-1 spec's own line, typed to the agent
    `You restarted it: ${m.reason}. Carry on from where you were.`
  );
}

export interface TellDeps {
  /** The agent's input state (agent-ops serverAgentInputState). */
  state: () => Promise<"missing" | "stopped" | "busy" | "idle">;
  /** Type `text` into its session, then Enter. */
  type: (text: string) => Promise<boolean>;
  /** How long to wait for its prompt (ui.restart_wait_seconds). */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Tell the agent the server is back: once it is at its prompt, or when
 * waitMs has passed (a runtime queues what is typed mid-turn). What
 * happened: told, or why not.
 */
export async function tellBack(
  text: string,
  d: TellDeps,
): Promise<"told" | "missing" | "stopped" | "not_typed"> {
  const now = d.now ?? Date.now;
  const sleep =
    d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + d.waitMs;
  for (;;) {
    const s = await d.state();
    if (s === "missing" || s === "stopped") return s;
    if (s === "idle" || now() >= until) break;
    await sleep(d.pollMs ?? 1000);
  }
  return (await d.type(text)) ? "told" : "not_typed";
}
