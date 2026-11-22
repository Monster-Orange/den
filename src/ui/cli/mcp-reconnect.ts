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
import {
  hubToolsListed,
  mcpLoadFailures,
  readHubMcpInit,
} from "../../shared/agents/hub-mcp-connect.js";
import { HUB_SERVER } from "../../shared/hub.js";
import { listRecords } from "../../shared/agents/records.js";
import {
  AgentError,
  agentDialogKind,
  agentScreenShowsDialog,
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

/** Issue 749: the line after Den restarted it because listing Hub's tools failed. */
export const LISTING_LINE =
  "Den restarted you to load Hub's tools (hub_*): listing them failed when you started. This is the same conversation; carry on.";

/** A running agent without Hub's tools; `listing`: its connect worked, the listing didn't. */
export interface HubToolsMissing {
  id: string;
  workspace: string;
  listing?: true;
}

/** Running agents whose Hub tools failed to load since they started. */
export async function hubToolsMissing(
  d: AgentsResolved,
): Promise<HubToolsMissing[]> {
  if ((await hubNow(d, true)) === null) return [];
  const c = await d.connectExisting();
  let live: { ref: { id: string }; exited?: unknown }[] = [];
  try {
    live = c ? (await c.list()).filter((s) => !s.exited) : [];
  } finally {
    c?.close();
  }
  const out: HubToolsMissing[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (!live.some((s) => s.ref.id === rec.session.id)) continue;
    // Issue 749: a connect that failed, or a tool listing that did.
    if (mcpLoadFailures(d.stateDir(), rec).some((f) => f.server === HUB_SERVER))
      out.push({
        id: rec.id,
        workspace: rec.workspace,
        ...(readHubMcpInit(d.stateDir(), rec.id)?.tools === false
          ? { listing: true as const }
          : {}),
      });
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
    missing?: (d: AgentsResolved) => Promise<HubToolsMissing[]>;
    log?: (line: string) => void;
    /** Issue 629: its note waits for the person's dialog (once). */
    held?: (id: string, workspace: string) => void;
    /**
     * Issue 749: listing Hub's tools failed again after Den's one restart
     * for it: the person is told once (the bell), with the error.
     */
    gaveUp?: (id: string, workspace: string, error: string) => void;
    /** Issue 749: a listing worked after gaveUp: its bell item can go. */
    listed?: (id: string) => void;
    /** Issue 629: the kept note was typed, or its agent went. */
    cleared?: (id: string) => void;
    /** How often a kept note looks at the dialog again (tests). */
    heldPollMs?: number;
    /**
     * Schedules a kept note's next look in `ms` (default: an unref'd
     * timer). Tests run the looks themselves, with no clock.
     */
    later?: (look: () => Promise<void>, ms: number) => void;
    /** How long its output must be still to count as waiting (tests). */
    quietMs?: number;
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
    line: string,
    hold: (why: string) => void,
  ): Promise<{ told: true } | { told: false; why: string } | null> => {
    const dialog = await agentDialogKind(d, id);
    if (dialog) return (hold(`its person's ${dialog} dialog is open`), null);
    const st = await agentInputState(d, id, new Set(), opts.quietMs ?? 1500);
    if (st === "missing") return { told: false, why: "it is gone" };
    if (st === "stopped") return { told: false, why: "it stopped" };
    if (st === "idle") {
      // Asked again once its turn in the typing queue comes: a Hub comment
      // typed just ahead may have started a turn. Not ready: it just waits.
      const r = await typeIntoAgent(d, id, line, {
        ready: async () =>
          !(await agentDialogKind(d, id)) &&
          (await agentInputState(d, id, new Set(), opts.quietMs ?? 1500)) ===
            "idle",
      });
      if (r === true) return { told: true };
      if (r === false) hold("its screen didn't take it; Den tries again");
    } else if (heldNotAtPrompt(id) || (await agentScreenShowsDialog(d, id)))
      // Issue 954: a list or a question on screen reads as a dialog, not
      // "not at its prompt" (issue 664's set), so it is asked here too:
      // the note waits, and its person is belled once.
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
  const tell = async (
    id: string,
    workspace: string,
    line: string,
  ): Promise<void> => {
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
        t = await look(id, line, hold);
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
      (opts.later ?? ((f, ms) => void setTimeout(() => void f(), ms).unref()))(
        step,
        opts.heldPollMs ?? 2000,
      );
    };
    await step();
  };
  const tries = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  /**
   * Issue 749: agents restarted once for a failed listing. Hub answering
   * Den says nothing of its tools/list, so a listing that keeps failing
   * would restart them after every turn: one restart, until a listing
   * works (kept across the gap while the new session hasn't listed yet).
   */
  const listingTried = new Set<string>();
  const belled = new Set<string>();
  return {
    async tick() {
      for (const id of listingTried) {
        if (!hubToolsListed(d.stateDir(), id)) continue;
        listingTried.delete(id);
        if (belled.delete(id)) opts.listed?.(id);
      }
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
        if (m.listing && listingTried.has(m.id)) {
          if (!belled.has(m.id)) {
            belled.add(m.id);
            const error =
              readHubMcpInit(d.stateDir(), m.id)?.error ??
              "listing Hub's tools failed";
            opts.gaveUp?.(m.id, m.workspace, error);
            opts.log?.(
              `agent ${m.id}: ${error} again after Den's restart; not restarted again until a listing works`,
            );
          }
          continue;
        }
        const n = tries.get(m.id) ?? 0;
        if (max > 0 && n >= max) continue;
        tries.set(m.id, n + 1);
        if (m.listing) listingTried.add(m.id);
        began.push(m.id);
        const p = restartAgent(d, m.id, m.workspace, "after-turn", {
          pollMs: opts.pollMs,
        })
          .then(() =>
            tell(
              m.id,
              m.workspace,
              m.listing ? LISTING_LINE : RECONNECTED_LINE,
            ),
          )
          .catch((err: unknown) => {
            // 0.4.48: still working (a turn, or a job it left running) when
            // agents.restart_wait_minutes ran out: skipped, tried again on a
            // later pass, and the try isn't spent.
            if (err instanceof AgentError && err.code === "still_busy") {
              tries.set(m.id, n);
              if (m.listing) listingTried.delete(m.id);
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
