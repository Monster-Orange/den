/**
 * Issue 193, as this server runs it: one HubToolsWatch (shared/hub-tools.ts)
 * for this install. Hub's tools/list is read with the install's token at
 * start, when an agent starts or resumes, and every hub.tools_check_seconds
 * (read each beat, so a change counts without a restart). A 2 s beat
 * records new conversations and types the note into an agent once it is
 * idle (agent-ops: agentInputState, typeIntoAgent).
 */
import path from "node:path";
import { HubToolsWatch, fetchHubTools } from "../../shared/hub-tools.js";
import { listRecords } from "../../shared/agents/records.js";
import { SERVER_AGENT_ID } from "../../shared/agents/server-agent.js";
import { getStateDir } from "../../shared/paths.js";

const BEAT_MS = 2000;

let timer: NodeJS.Timeout | null = null;

/** hub.tools_check_seconds now (a bad hub block: the default). */
async function checkSeconds(): Promise<number> {
  const hub = await import("../../shared/hub.js");
  try {
    return hub.readHubConfig()?.toolsCheckSeconds ?? 300;
  } catch {
    return 300; // doctor says so; the default meanwhile
  }
}

export function startHubToolsWatch(o: {
  waiting: () => ReadonlySet<string>;
  log: (line: string) => void;
}): void {
  if (timer) return;
  let w: HubToolsWatch | null = null;
  let busy = false;
  let last = Date.now();
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!w) {
        const hub = await import("../../shared/hub.js");
        const ops = await import("../cli/agent-ops.js");
        const { webDeps } = await import("./agent-routes.js");
        const d = webDeps();
        w = new HubToolsWatch({
          fetchTools: async () => {
            const cfg = hub.readHubConfig();
            if (!cfg) return null;
            const token = await hub.readHubToken(cfg);
            if (!token) return null;
            return fetchHubTools(cfg.mcpUrl || `${cfg.url}/mcp`, token);
          },
          agents: () =>
            listRecords(getStateDir()).map((r) => ({
              id: r.id,
              conv: r.resumeToken ? `${r.runtime} ${r.resumeToken}` : null,
              launchedAt: r.resumedAt ?? r.startedAt,
            })),
          state: (id) =>
            id === SERVER_AGENT_ID
              ? ops.serverAgentInputState(d)
              : ops.agentInputState(d, id, o.waiting()),
          type: (id, text) => ops.typeIntoAgent(d, id, text),
          file: path.join(getStateDir(), "hub", "tools-seen.json"),
          log: o.log,
        });
      }
      if (Date.now() - last >= (await checkSeconds()) * 1000) {
        last = Date.now();
        await w.check();
      }
      await w.pump();
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void beat().catch(() => undefined), BEAT_MS);
  timer.unref();
}
