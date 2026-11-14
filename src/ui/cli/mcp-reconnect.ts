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
 */
import { readHubMcpInit } from "../../shared/agents/hub-mcp-connect.js";
import { listRecords } from "../../shared/agents/records.js";
import {
  hubNow,
  restartAgent,
  typeIntoAgent,
  type AgentsResolved,
} from "./agent-ops.js";

/** What the agent reads in its pane after Den restarted it. */
export const RECONNECTED_LINE =
  "Den restarted you to load Hub's tools (hub_*): Hub didn't answer when you started. This is the same conversation; carry on."; // words-ok: typed to the agent

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
  /** Restarts under way (they wait for the agent's turn to end). */
  pending(): Promise<void>;
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
  },
): McpReconnect {
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
        if (running.has(m.id)) continue;
        const n = tries.get(m.id) ?? 0;
        if (max > 0 && n >= max) continue;
        tries.set(m.id, n + 1);
        began.push(m.id);
        const p = restartAgent(d, m.id, m.workspace, "after-turn", {
          pollMs: opts.pollMs,
        })
          .then(() => typeIntoAgent(d, m.id, RECONNECTED_LINE))
          .then(() =>
            opts.log?.(`agent ${m.id}: restarted to load Hub's tools`),
          )
          .catch((err: unknown) =>
            opts.log?.(
              `agent ${m.id}: not restarted for Hub's tools: ${(err as Error)?.message ?? err}`,
            ),
          )
          .finally(() => running.delete(m.id));
        running.set(m.id, p);
      }
      return began;
    },
    async pending() {
      await Promise.all([...running.values()]);
    },
  };
}
