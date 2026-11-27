/**
 * Issue 193, as this server runs it: one HubToolsWatch (shared/hub-tools.ts)
 * for this install. Hub's tools/list is read with the install's token at
 * start, when an agent starts or resumes, and every hub.tools_check_seconds
 * (read each beat, so a change counts without a restart). A 2 s beat
 * records new conversations and types the note into an agent once it is
 * idle (agent-ops: agentInputState, typeIntoAgent).
 *
 * 0.4.56: an agent whose runtime reads its tool list only at launch
 * (Runtime.reloadsToolsInPlace unset: Claude Code) is restarted instead,
 * at its next idle, on the same conversation (agent-ops restartAgent,
 * after-turn), unless its project's hub.tools_restart is off. This is
 * Den's own action, not a request: no route, no person check; an audit row
 * says Den did it. While it runs, the agent's row says so
 * (hubToolsRestarting).
 */
import path from "node:path";
import { HubToolsWatch, fetchHubTools } from "../../shared/hub/hub-tools.js";
import { listRecords, readRecord } from "../../shared/agents/records.js";
import { getRuntime } from "../../shared/agents/runtime.js";
import { workspaceHubToolsRestart } from "../../shared/environment-manager/workspaces.js";
import { SERVER_AGENT_ID } from "../../shared/agents/server-agent.js";
import { getStateDir } from "../../shared/paths.js";

const BEAT_MS = 2000;

let timer: NodeJS.Timeout | null = null;
let watch: HubToolsWatch | null = null;

/** The agents Den is restarting now to load Hub's tools (their rows say so). */
/**
 * Issue 726: the Hub changed: forget the tool lists seen (the next beat
 * reads the fresh file).
 */
export function dropToolsWatch(): void {
  watch = null;
}

export function hubToolsRestarting(): ReadonlySet<string> {
  return new Set(watch?.restarting() ?? []);
}

/** hub.tools_restart for the install (a bad hub block: the default, on). */
async function installRestartOn(): Promise<boolean> {
  const hub = await import("../../shared/hub.js");
  try {
    return hub.readHubConfig()?.toolsRestart ?? true;
  } catch {
    return true;
  }
}

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
  let installOn = true;
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
        const { recordAction } = await import("./audit.js");
        const d = webDeps();
        const rec = (id: string) => readRecord(getStateDir(), id);
        // Issue 1129: Hub's tools restart agents through the one queue
        // (agents.resume): a batch at a time, never all at once.
        const { restartQueue } = await import("./restart-queue-service.js");
        const { notificationDeps } = await import("./notification-service.js");
        const queue = restartQueue({
          log: o.log,
          store: () => notificationDeps().store,
        });
        const restartOne = async (id: string): Promise<void> => {
          const r = rec(id);
          if (!r) throw new Error(`agent ${id} is gone`);
          const what = `restart ${id} in ${r.workspace} (at its next idle), same conversation, to load Hub's new tools, by Den itself`;
          try {
            const s = await ops.restartAgent(d, id, r.workspace, "after-turn");
            recordAction(null, {
              verb: "agents",
              detail: s.already
                ? `${what}: already restarted at ${s.already.at}`
                : s.relaunched
                  ? `${what}: it had rotated (${s.relaunched.why}), so it relaunched from its handoff in a new conversation`
                  : what,
              ...(s.early
                ? { outcome: "refused" as const, reason: "exited at once" }
                : {}),
            });
          } catch (e) {
            recordAction(null, {
              verb: "agents",
              detail: what,
              outcome: "refused",
              reason: e instanceof Error ? e.message : String(e),
            });
            throw e;
          }
        };
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
          reloadsInPlace: (id) => {
            const r = rec(id);
            return Boolean(r && getRuntime(r.runtime)?.reloadsToolsInPlace);
          },
          restartOn: (id) => {
            const r = rec(id);
            return r ? workspaceHubToolsRestart(r.workspace, installOn) : false;
          },
          restart: (id) =>
            queue.add({ id, why: "hub-tools", run: () => restartOne(id) }),
          file: path.join(getStateDir(), "hub", "tools-seen.json"),
          log: o.log,
        });
        watch = w;
      }
      if (Date.now() - last >= (await checkSeconds()) * 1000) {
        last = Date.now();
        await w.check();
      }
      installOn = await installRestartOn();
      await w.pump();
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void beat().catch(() => undefined), BEAT_MS);
  timer.unref();
}
