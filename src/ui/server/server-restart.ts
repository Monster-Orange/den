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
import { recordAction, type AuditEntry } from "./audit.js";
import type { Actor } from "../../shared/agent-actor.js";
import type { LastUpdate } from "./den-update.js";

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
  /**
   * SRV-P6: Den's own update (its check, no agent asked). The server
   * agent, which keeps the pin, is told all the same.
   */
  by?: "den";
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
      ...(m.by === "den" ? { by: "den" as const } : {}),
    };
  } catch {
    return null;
  }
}

/** At most this many doctor lines go into the line Den types. */
const DOCTOR_LINES_MAX = 8;

/**
 * #384: what the new Den's doctor found for the update this restart is
 * back from, said in the line itself. The agent reading it runs Den tools
 * that started before the update (its MCP server is a child of its
 * session, which outlives the restart), so the line sends it to no tool
 * for this. One line: what is typed is submitted with Enter.
 */
function doctorNews(
  m: RestartMarker,
  version: string,
  update: LastUpdate | null | undefined,
): string {
  const ours =
    update &&
    [update.from, update.to].includes(version) &&
    [update.from, update.to].includes(m.fromVersion);
  if (!ours || !update.doctor)
    return " No doctor results were kept for this update.";
  const lines = update.doctor.lines.map((l) =>
    l.replace(/\s+/g, " ").trim().slice(0, 200),
  );
  if (!lines.length)
    return " The new Den's doctor found nothing failing or warning.";
  const more = lines.length - DOCTOR_LINES_MAX;
  return (
    ` The new Den's doctor found: ${lines.slice(0, DOCTOR_LINES_MAX).join("; ")}` +
    (more > 0 ? `; and ${more} more` : "") +
    "."
  );
}

/**
 * #384: an update leaves the agent's Den tools on the Den they started on.
 * #390: Den restarts it at its next idle to load the new one, unless
 * server_agent.refresh_agents is off.
 */
function toolsLine(version: string, refresh: boolean): string {
  return refresh
    ? ` Den restarts you at your next idle to load ${version}'s tools (this conversation stays).`
    : " Your Den tools still run the Den they started on.";
}

/**
 * What Den types into the agent's session when the new server is up.
 * `update`: Den's last update of itself (lastUpdate), for its doctor
 * results when this restart is back from it.
 */
export function backMessage(
  m: RestartMarker,
  version: string,
  pid: number,
  update?: LastUpdate | null,
  /** #390: server_agent.refresh_agents (default on). */
  opts: { refresh?: boolean } = {},
): string {
  const refresh = opts.refresh ?? true;
  if (m.by === "den")
    return m.rolledBack
      ? `Den is back on ${version} (pid ${pid}), rolled back: ${m.reason}. ` +
          "Den's own update didn't take: commit no pin change. The person has it in the bell." +
          doctorNews(m, version, update)
      : `Den is back on ${version} (pid ${pid}) (it was ${m.fromVersion}). ` +
          `Den updated itself: ${m.reason}. Den commits and pushes the new pin itself (server_agent.pin_commit); commit it yourself only when that is off.` +
          doctorNews(m, version, update) +
          toolsLine(version, refresh);
  if (m.rolledBack)
    return (
      `Server is back on ${version} (pid ${pid}), rolled back: ${m.reason}. ` + // words-ok: SRV-1 spec's own line, typed to the agent
      "Your update didn't take: commit no pin change, and tell your person why." +
      doctorNews(m, version, update)
    );
  const was = m.fromVersion === version ? "" : ` (it was ${m.fromVersion})`;
  // An update the agent asked for (den_update): what doctor found, and
  // that its tools are still the old Den's.
  const updated =
    m.fromVersion !== version &&
    update?.from === m.fromVersion &&
    update.to === version
      ? doctorNews(m, version, update) + toolsLine(version, refresh)
      : "";
  return (
    `Server is back on ${version} (pid ${pid})${was}. ` + // words-ok: SRV-1 spec's own line, typed to the agent
    `You restarted it: ${m.reason}.${updated} Carry on from where you were.`
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

/**
 * Issue 227: the page actions that restart Den (POST /api/web/restart's
 * `from`), in the audit row's words.
 */
export const PAGE_RESTART_FROM: Readonly<Record<string, string>> = {
  "update-pill": "Reload in the update pill",
  menu: "Restart Den in the menu",
  settings: "Restart Den in Settings",
};

/**
 * Issue 227: a person's restart from the page, one audit row (as an
 * agent's held restart has): who (the credential's principal), when, and
 * which page action. An action the page doesn't name is just the page.
 */
export function recordPageRestart(
  body: unknown,
  actor: Actor,
  principal: string | undefined,
): AuditEntry {
  const from = (body as { from?: unknown } | null | undefined)?.from;
  const words =
    typeof from === "string" && Object.hasOwn(PAGE_RESTART_FROM, from)
      ? PAGE_RESTART_FROM[from]
      : "";
  return recordAction(
    actor,
    {
      verb: "server-restart",
      detail: `asked by the person from the page${words ? `: ${words}` : ""}`,
    },
    principal,
  );
}
