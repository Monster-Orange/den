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
 *
 * Issue 251: the marker is told once, not read once. Taking it moves it
 * aside (restart.telling.json) until its note is typed
 * (finishRestartMarker), so a server that restarts again before then
 * leaves it for the next start. A restart of the same agent in between
 * carries Den's own update in its marker (`update`), so the pin line is
 * still typed; a rollback replaces it. The back row has the typed note and
 * the agent's input state at that moment (backAudit).
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
  /**
   * Issue 251: Den's own update this restart came after, not yet told
   * (a second restart before its note was typed).
   */
  update?: { fromVersion: string; reason: string; at: string };
  /** Issue 251: taken by an earlier start that didn't type its note. */
  again?: boolean;
}

/** A marker older than this is a restart that never came back: ignored. */
export const MARKER_MAX_AGE_MS = 24 * 60 * 60_000;

export function restartMarkerPath(stateDir: string): string {
  return path.join(stateDir, "server-agent", "restart.json");
}

/** Leave the marker the next server takes (0600, in a 0700 folder). */
export function writeRestartMarker(stateDir: string, m: RestartMarker): void {
  writeMarkerFile(restartMarkerPath(stateDir), m);
}

function writeMarkerFile(p: string, m: RestartMarker): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** Issue 251: a taken marker whose note isn't typed yet. */
export function tellingMarkerPath(stateDir: string): string {
  return path.join(stateDir, "server-agent", "restart.telling.json");
}

/** One marker file, checked; null when none, unreadable or stale. */
function readMarker(p: string, now: number): RestartMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
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
    const u = m.update;
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
      ...(u &&
      typeof u.fromVersion === "string" &&
      typeof u.reason === "string" &&
      typeof u.at === "string"
        ? {
            update: {
              fromVersion: u.fromVersion,
              reason: u.reason,
              at: u.at,
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Issue 251: the self-update a marker still has to tell, or null. */
function selfUpdateOf(m: RestartMarker): RestartMarker["update"] | null {
  if (m.rolledBack) return null;
  if (m.by === "den")
    return { fromVersion: m.fromVersion, reason: m.reason, at: m.at };
  return m.update ?? null;
}

/**
 * The marker a restart left, for this start to tell. Issue 251: it stays
 * (aside) until finishRestartMarker, so a start that ends first leaves it
 * to the next one (`again`). A fresh marker of the same agent's restart
 * carries an untold self-update (`update`); a rollback, or Den's own
 * marker, replaces it. Null: none, unreadable, or older than
 * MARKER_MAX_AGE_MS.
 */
export function takeRestartMarker(
  stateDir: string,
  now: number = Date.now(),
): RestartMarker | null {
  const p = restartMarkerPath(stateDir);
  const t = tellingMarkerPath(stateDir);
  const fresh = readMarker(p, now);
  const pending = readMarker(t, now);
  let m: RestartMarker | null;
  if (fresh) {
    const carried = pending ? selfUpdateOf(pending) : null;
    m =
      carried &&
      fresh.by !== "den" &&
      !fresh.rolledBack &&
      (fresh.agent ?? pending!.agent) === pending!.agent
        ? { ...fresh, agent: pending!.agent, update: carried }
        : fresh;
  } else m = pending ? { ...pending, again: true } : null;
  try {
    if (m) writeMarkerFile(t, m);
    else fs.rmSync(t, { force: true });
  } catch {
    /* can't set it aside: told this once */
  }
  try {
    fs.unlinkSync(p);
  } catch {
    /* gone already */
  }
  return m;
}

/** Issue 251: its note is typed (or there was nobody to tell): done. */
export function finishRestartMarker(stateDir: string): void {
  try {
    fs.rmSync(tellingMarkerPath(stateDir), { force: true });
  } catch {
    /* best effort: a stale one ages out (MARKER_MAX_AGE_MS) */
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

/** #384: an update leaves the agent's Den tools on the Den they started on. */
const TOOLS_LINE =
  " Your Den tools keep running the Den they started on until the person restarts you from Den (Restart keeps this conversation).";

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
): string {
  // Issue 251: Den's own update, then this restart before it was told.
  if (m.update && !m.by && !m.rolledBack)
    return (
      backMessage(
        {
          ...m,
          by: "den",
          fromVersion: m.update.fromVersion,
          reason: m.update.reason,
        },
        version,
        pid,
        update,
      ) +
      ` It restarted again since: ${m.reason}. Carry on from where you were.`
    );
  if (m.by === "den")
    return m.rolledBack
      ? `Den is back on ${version} (pid ${pid}), rolled back: ${m.reason}. ` +
          "Den's own update didn't take: commit no pin change. The person has it in the bell." +
          doctorNews(m, version, update)
      : `Den is back on ${version} (pid ${pid}) (it was ${m.fromVersion}). ` +
          `Den updated itself: ${m.reason}. Den commits and pushes the new pin itself (server_agent.pin_commit); commit it yourself only when that is off.` +
          doctorNews(m, version, update) +
          TOOLS_LINE;
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
      ? doctorNews(m, version, update) + TOOLS_LINE
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
  return (await tellBackDetail(text, d)).told;
}

/** Issue 251: what tellBack did, and the agent's input state then. */
export interface Told {
  told: "told" | "missing" | "stopped" | "not_typed";
  /** The last state read: idle, or busy when the wait ran out. */
  state: "missing" | "stopped" | "busy" | "idle";
}

/** tellBack, with the input state at the moment it typed (issue 251). */
export async function tellBackDetail(text: string, d: TellDeps): Promise<Told> {
  const now = d.now ?? Date.now;
  const sleep =
    d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + d.waitMs;
  let s: Told["state"] = "busy";
  for (;;) {
    s = await d.state();
    if (s === "missing" || s === "stopped") return { told: s, state: s };
    if (s === "idle" || now() >= until) break;
    await sleep(d.pollMs ?? 1000);
  }
  return { told: (await d.type(text)) ? "told" : "not_typed", state: s };
}

/**
 * Issue 251: the server-back audit row: a short detail (the trail's
 * line), and in `agents` the exact note typed and the agent's input state
 * at that moment, in full. `told` is a Told, or why nobody was told.
 */
export function backAudit(
  m: RestartMarker,
  version: string,
  pid: number,
  text: string,
  told: Told | string,
): { detail: string; agents?: Record<string, unknown> } {
  const who = m.agent ? `agent:${m.agent}` : "the asker";
  const how =
    typeof told === "string"
      ? told
      : told.told === "told" || told.told === "not_typed"
        ? `${told.told} (typed while ${told.state})`
        : told.told;
  const detail =
    `on ${version} (pid ${pid}), was ${m.fromVersion}${m.fromPid ? ` (pid ${m.fromPid})` : ""}: ${m.reason} [${m.id}]; ${who} ${how}` +
    (m.update ? `; carries Den's update from ${m.update.fromVersion}` : "") +
    (m.again ? "; kept from an earlier start that didn't type it" : "");
  return {
    detail: detail.slice(0, 400),
    ...(m.agent && typeof told !== "string"
      ? {
          agents: {
            [m.agent]: { told: told.told, state: told.state, typed: text },
          },
        }
      : {}),
  };
}

/**
 * Issue 251: the line Den types again when the pin of `version` isn't
 * committed `minutes` after the update.
 */
export function pinReminder(
  version: string,
  folder: string,
  minutes: number,
): string {
  return (
    `Den ${version} runs here, but its new pin (package.json, package-lock.json) in ${folder} is still not committed ${minutes} min after the update. ` +
    "Commit and push it now, or tell your person why you can't."
  );
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
