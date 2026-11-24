/**
 * Issue 1328: agent_sandbox_set, a held write that turns one agent's
 * sandbox off or on (agents.<id>.sandbox in the person's user.yml), so the
 * person never edits the file by hand.
 *
 * Off widens what the agent may do: only the person's own Allow runs it,
 * and the Review says plainly when the agent asks for itself. On narrows
 * it, so it follows the approval policy (by default it runs at once).
 * On Allow, Den writes only that key, notes when, why and who asked
 * (sandbox-off.json in the state folder, for agents doctor), and restarts a
 * running agent after its turn on the same conversation, so it starts with
 * the change.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import {
  line,
  reviewLines,
  type DetailKey,
  type ReviewLine,
} from "../review-lines.js";
import { sandboxRequired, sandboxSetting } from "./sandbox.js";
import { isServerScope } from "./server-agent.js";

export const AGENT_SANDBOX_SET_ACTION = "agent_sandbox_set";
/** The longest reason an ask may give (one line). */
export const SANDBOX_REASON_MAX = 300;
export const SANDBOX_NOTES_FILE = "sandbox-off.json";

export interface SandboxSetArgs {
  agent: string;
  project: string;
  on: boolean;
  reason?: string;
}

/** When, why and who asked for an agent's sandbox to go off. */
export interface SandboxNote {
  at: string;
  why: string;
  by: string;
}

/** What the check needs of an agent's record. */
export interface SandboxSetAgent {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
}

export interface SandboxSetDeps {
  /** The agent's record; throws when there is none. */
  record: (id: string, project?: string) => SandboxSetAgent;
  /** The resolved agents config (agents.sandbox and agents.<id>.sandbox). */
  agentsConfig: () => {
    sandbox?: boolean;
    sandboxRequired?: boolean;
    agents?: Record<string, { sandbox?: boolean; sandboxRequired?: boolean }>;
  };
  /** Writes agents.<id>.sandbox in user.yml, and nothing else. */
  write: (id: string, on: boolean) => void;
  /** Keeps the note (off), or drops it (null: back on). */
  note: (id: string, n: SandboxNote | null) => void;
  /** Restarts the agent after its turn, on the same conversation. */
  restart: (id: string, project: string) => Promise<unknown>;
  now: () => string;
}

export type SandboxSetCheck =
  | {
      ok: true;
      personOnly?: boolean;
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      args: SandboxSetArgs;
    }
  | { ok: false; error: string };

/**
 * Text on one line with no control or format characters (terminal escapes,
 * bidi controls): what the Review and agents doctor show of an agent's
 * words or a hand-edited notes file.
 */
export function plainText(v: string): string {
  return (
    v
      // Whole terminal sequences first (CSI, OSC), so none of one is left.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      .replace(/\s+/g, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/** The reason, on one line; an error when it is too long or not text. */
function reasonOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error("reason must be text");
  const r = plainText(v);
  if (r.length > SANDBOX_REASON_MAX)
    throw new Error(
      `reason must be ${SANDBOX_REASON_MAX} characters or fewer (got ${r.length})`,
    );
  return r || undefined;
}

export function checkAgentSandboxSet(
  d: SandboxSetDeps,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): SandboxSetCheck {
  const no = (error: string): SandboxSetCheck => ({ ok: false, error });
  try {
    const id = typeof raw.agent === "string" ? raw.agent.trim() : "";
    if (!id) return no("agent is required (the agent's id)");
    if (typeof raw.on !== "boolean")
      return no(
        "on must be true or false (true: back in the sandbox; false: out of it)",
      );
    const on = raw.on;
    const reason = reasonOf(raw.reason);
    if (!on && !reason)
      return no(
        "reason is required to turn a sandbox off: say what the agent needs that the sandbox blocks",
      );
    const project =
      typeof raw.project === "string" && raw.project.trim()
        ? raw.project.trim()
        : undefined;
    const rec = d.record(id, project);
    if (
      who.project &&
      !isServerScope(who.project) &&
      who.project !== rec.workspace
    )
      return no(
        `${who.agent ?? "this agent"} works in project ${who.project}: it can ask for that project's agents only, not ${id} in project ${rec.workspace}`,
      );
    const cfg = d.agentsConfig();
    const now = sandboxSetting(cfg, id);
    if (now === on)
      return no(
        on
          ? `${id} is already in the sandbox`
          : `${id}'s sandbox is already off`,
      );
    if (!on && sandboxRequired(cfg, id))
      return no(
        `the sandbox is required for ${id} on this machine (agents.sandbox: required): a person changes that in Settings`,
      );
    const shown = rec.displayName ?? id;
    const self =
      who.agent === id && (!who.project || who.project === rec.workspace);
    const running = !rec.stoppedAt;
    const value = on ? "on" : "off";
    const lines = [
      ...(self
        ? [
            line(
              `${shown} is asking for this itself: it wants its own sandbox ${value}.`,
              "ap.det.agent_sandbox_set.self",
              { agent: shown, value },
            ),
          ]
        : []),
      on
        ? line(
            `This puts ${shown} back in the sandbox: Den's own files are read-only to it again.`,
            "ap.det.agent_sandbox_set.on",
            { agent: shown },
          )
        : line(
            `This takes ${shown} out of the sandbox: it can then write Den's own files and reach what the sandbox blocks.`,
            "ap.det.agent_sandbox_set.off",
            { agent: shown },
          ),
      shown !== id
        ? line(
            `Agent: ${shown} (${id}), project ${rec.workspace}`,
            "ap.det.agent.whoId",
            { agent: shown, id, project: rec.workspace },
          )
        : line(
            `Agent: ${shown}, project ${rec.workspace}`,
            "ap.det.agent.who",
            {
              agent: shown,
              project: rec.workspace,
            },
          ),
      ...(reason
        ? [
            line(`Why: ${reason}`, "ap.det.agent_sandbox_set.why", {
              why: reason,
            }),
          ]
        : []),
      line(
        `Den writes agents.${id}.sandbox: ${value} in config/local/user.yml, and nothing else there.`,
        "ap.det.agent_sandbox_set.writes",
        { id, value },
      ),
      running
        ? line(
            "It is running: Den restarts it after its turn, on the same conversation, with the change.",
            "ap.det.agent_sandbox_set.running",
          )
        : line(
            "It is stopped: its next start has the change.",
            "ap.det.agent_sandbox_set.stopped",
          ),
    ];
    const r = reviewLines(lines);
    return {
      ok: true,
      ...(on ? {} : { personOnly: true }),
      summary: on
        ? `${shown}: back in the sandbox`
        : `This takes ${shown} out of the sandbox`,
      params: {
        agent: shown,
        ...(on ? {} : { loosens: "1" }),
        ...(self ? { self: "1" } : {}),
      },
      details: r.details,
      detailKeys: r.detailKeys,
      args: {
        agent: id,
        project: rec.workspace,
        on,
        ...(reason ? { reason } : {}),
      },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * On Allow: checks again, writes the one key, keeps or drops the note, and
 * restarts a running agent after its turn (not waited for: the turn may be
 * the one that asked).
 */
export async function runAgentSandboxSet(
  d: SandboxSetDeps,
  raw: Record<string, unknown>,
  asked?: { agent?: string },
): Promise<
  | {
      ok: true;
      agent: string;
      project: string;
      sandbox: "on" | "off";
      restarts: boolean;
    }
  | { ok: false; error: string }
> {
  const c = checkAgentSandboxSet(d, raw);
  if (!c.ok) return c;
  const { agent, project, on, reason } = c.args;
  d.write(agent, on);
  d.note(
    agent,
    on
      ? null
      : { at: d.now(), why: reason ?? "", by: asked?.agent ?? "a person" },
  );
  const restarts = !d.record(agent, project).stoppedAt;
  if (restarts) void d.restart(agent, project).catch(() => undefined);
  return { ok: true, agent, project, sandbox: on ? "on" : "off", restarts };
}

/**
 * Why a new agent that gets one of `ids` would start outside the sandbox
 * (its own agents.<id>.sandbox: off, or agents.sandbox: off for the
 * machine), as a Review line; null when it starts in it. agent_create and
 * agent_import then need the person's own Allow, as turning a sandbox off
 * does.
 */
export function newAgentSandboxOff(
  cfg: ReturnType<SandboxSetDeps["agentsConfig"]>,
  ids: readonly string[],
): ReviewLine | null {
  for (const id of ids) {
    if (sandboxSetting(cfg, id) || sandboxRequired(cfg, id)) continue;
    return cfg.agents?.[id]?.sandbox === false
      ? line(
          `${id} starts outside the sandbox: agents.${id}.sandbox is off in config/local/user.yml.`,
          "ap.det.agent.sandboxOff",
          { id },
        )
      : line(
          "Agents here start outside the sandbox (agents.sandbox: off), and so would this one.",
          "ap.det.agent.sandboxOffAll",
        );
  }
  return null;
}

/** The refusal when a new agent's sandbox went off after it was asked for. */
export const SANDBOX_OFF_SINCE_ASK =
  "this agent would start outside the sandbox, which changed after it was asked for: ask again, so the person sees it";

const isNote = (v: unknown): v is SandboxNote =>
  !!v &&
  typeof v === "object" &&
  typeof (v as SandboxNote).at === "string" &&
  typeof (v as SandboxNote).why === "string" &&
  typeof (v as SandboxNote).by === "string";

/** The notes by agent id; none when the file is missing or bad. */
export function readSandboxNotes(
  stateDir: string,
): Record<string, SandboxNote> {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(stateDir, SANDBOX_NOTES_FILE), "utf-8"),
    ) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, SandboxNote> = {};
    for (const [id, n] of Object.entries(v)) if (isNote(n)) out[id] = n;
    return out;
  } catch {
    return {};
  }
}

/** Keeps agent `id`'s note, or drops it (null). */
export function writeSandboxNote(
  stateDir: string,
  id: string,
  n: SandboxNote | null,
): void {
  const all = readSandboxNotes(stateDir);
  if (n) all[id] = n;
  else delete all[id];
  fs.mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(
    path.join(stateDir, SANDBOX_NOTES_FILE),
    JSON.stringify(all, null, 2) + "\n",
  );
}
