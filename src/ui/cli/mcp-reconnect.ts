/**
 * 0.4.46: Den reconnects an agent's Hub tools by itself. An agent that
 * started while Hub didn't answer (its MCP connect failed: the /hub
 * proxy's note, hub-mcp-connect.ts) has no hub_* tools until it connects
 * again. Before, it asked the person to press Restart. Now, every
 * `hub.mcp_retry_seconds` Den asks whether Hub answers; once it does, it
 * restarts each such agent after its turn (the same conversation, as
 * Restart does) and tells it in its pane. At most
 * `hub.mcp_retry_attempts` restarts per agent (0: no limit), counted only
 * when Hub answered, so a long outage spends none.
 *
 * Issue 629: Den never types into a dialog for the agent's person. While
 * one is open the note is kept (held: the bell says it waits) and typed
 * once the person has answered (cleared: the bell item goes).
 */
import { readHubMcpInit } from "../../shared/agents/hub-mcp-connect.js";
import { listRecords } from "../../shared/agents/records.js";
import {
  AgentError,
  agentDialogKind,
  agentInputState,
  heldNotAtPrompt,
  hubNow,
  restartAgent,
  typeIntoAgent,
  type AgentsResolved,
} from "./agent-ops.js";

/** What the agent reads in its pane after Den restarted it. */
export const RECONNECTED_LINE =
  "Den restarted you to load Hub's tools (hub_*): Hub didn't answer when you started. This is the same conversation; carry on.";

/** Running agents whose Hub connect failed since they started. */
export async function hubToolsMissing(
  d: AgentsResolved,
): Promise<{ id: string; workspace: string }[]> {
  if ((await hubNow(d, true)) === null) return [];
  const c = await d.connectExisting();
  let live: { ref: { id: string }; exited?: unknown }[] = [];
  try {
    live = c ? (await c.list()).filter((s) => !s.exited) : [];
  } finally {
    c?.close();
  }
  const out: { id: string; workspace: string }[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (!live.some((s) => s.ref.id === rec.session.id)) continue;
    const init = readHubMcpInit(d.stateDir(), rec.id);
    if (init && !init.ok && Date.parse(init.at) >= Date.parse(rec.startedAt))
      out.push({ id: rec.id, workspace: rec.workspace });
  }
  return out;
}

export interface McpReconnect {
  /** One pass: the agents it began restarting. */
  tick(): Promise<string[]>;
  /**
   * Restarts under way (they wait for the agent's turn to end, then look
   * once at whether it can take its note).
   */
  pending(): Promise<void>;
  /** Issue 629: agents whose note is queued, waiting for them to take it. */
  waiting(): string[];
}

export function mcpReconnect(
  d: AgentsResolved,
  opts: {
    /** Whether Hub answers now (Den's own call to it). */
    hubUp: () => Promise<boolean>;
    /** hub.mcp_retry_attempts (0: no limit). */
    attempts: () => number;
    /** How often after-turn looks at the turn (tests). */
    pollMs?: number;
    missing?: (
      d: AgentsResolved,
    ) => Promise<{ id: string; workspace: string }[]>;
    log?: (line: string) => void;
    /** Issue 629: its note waits for the person's dialog (once). */
    held?: (id: string, workspace: string) => void;
    /** Issue 629: the kept note was typed, or its agent went. */
    cleared?: (id: string) => void;
    /** How often a kept note looks at the dialog again (tests). */
    heldPollMs?: number;
  },
): McpReconnect {
  /**
   * Issue 629: one look at the agent. Type the line if it is idle. While it
   * can't take it (a dialog for its person, a list, not at its prompt, or
   * the screen refused it), bell once and keep waiting (null); a plain turn
   * waits with no bell. Done only when typed, or when the agent stops or
   * goes: what it says is why.
   */
  const look = async (
    id: string,
    hold: (why: string) => void,
  ): Promise<{ told: true } | { told: false; why: string } | null> => {
    const dialog = await agentDialogKind(d, id);
    if (dialog) return (hold(`its person's ${dialog} dialog is open`), null);
    const st = await agentInputState(d, id, new Set(), 1500);
    if (st === "missing") return { told: false, why: "it is gone" };
    if (st === "stopped") return { told: false, why: "it stopped" };
    if (st === "idle") {
      if (await typeIntoAgent(d, id, RECONNECTED_LINE)) return { told: true };
      hold("its screen didn't take it; Den tries again");
    } else if (heldNotAtPrompt(id))
      hold("it isn't at its input prompt (a list or a question shows)");
    return null;
  };
  /**
   * The notes that wait for their agent. A note is queued, not a call that
   * waits: each look is scheduled on an unref'd timer, so a restart's
   * promise (pending()) ends after the first look whatever the agent does.
   * No time limit: it waits as long as its agent runs.
   */
  const notes = new Map<string, { held: boolean }>();
  const told = (id: string, t: { told: true } | { told: false; why: string }) =>
    opts.log?.(
      t.told
        ? `agent ${id}: restarted to load Hub's tools`
        : `agent ${id}: restarted to load Hub's tools; its note wasn't typed (${t.why})`,
    );
  const tell = async (id: string, workspace: string): Promise<void> => {
    const n = { held: false };
    notes.set(id, n);
    const hold = (why: string) => {
      if (n.held) return;
      n.held = true;
      opts.held?.(id, workspace);
      opts.log?.(`agent ${id}: Den's note about Hub's tools waits: ${why}`);
    };
    const step = async (): Promise<void> => {
      if (notes.get(id) !== n) return;
      let t: Awaited<ReturnType<typeof look>> = null;
      try {
        t = await look(id, hold);
      } catch (err) {
        opts.log?.(
          `agent ${id}: Den's note about Hub's tools: ${(err as Error)?.message ?? err}; Den tries again`,
        );
      }
      if (notes.get(id) !== n) return;
      if (t) {
        notes.delete(id);
        if (n.held) opts.cleared?.(id);
        told(id, t);
        return;
      }
      setTimeout(() => void step(), opts.heldPollMs ?? 2000).unref();
    };
    await step();
  };
  const tries = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  return {
    async tick() {
      const missing = await (opts.missing ?? hubToolsMissing)(d);
      const ids = new Set(missing.map((m) => m.id));
      for (const id of tries.keys()) if (!ids.has(id)) tries.delete(id);
      if (!missing.length || !(await opts.hubUp().catch(() => false)))
        return [];
      const max = opts.attempts();
      const began: string[] = [];
      for (const m of missing) {
        // A note still queued: its restart is under way (issue 629).
        if (running.has(m.id) || notes.has(m.id)) continue;
        const n = tries.get(m.id) ?? 0;
        if (max > 0 && n >= max) continue;
        tries.set(m.id, n + 1);
        began.push(m.id);
        const p = restartAgent(d, m.id, m.workspace, "after-turn", {
          pollMs: opts.pollMs,
        })
          .then(() => tell(m.id, m.workspace))
          .catch((err: unknown) => {
            // 0.4.48: still working (a turn, or a job it left running) when
            // agents.restart_wait_minutes ran out: skipped, tried again on a
            // later pass, and the try isn't spent.
            if (err instanceof AgentError && err.code === "still_busy") {
              tries.set(m.id, n);
              opts.log?.(
                `agent ${m.id}: still running a job or its turn; Hub's tools restart tried again later`,
              );
              return;
            }
            opts.log?.(
              `agent ${m.id}: not restarted for Hub's tools: ${(err as Error)?.message ?? err}`,
            );
          })
          .finally(() => running.delete(m.id));
        running.set(m.id, p);
      }
      return began;
    },
    async pending() {
      await Promise.all([...running.values()]);
    },
    waiting() {
      return [...notes.keys()];
    },
  };
}
