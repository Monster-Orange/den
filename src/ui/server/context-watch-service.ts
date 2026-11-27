/**
 * Issue 278, as this server runs it: every few seconds, each running
 * agent's compactions (its runtime's `compactions`: Claude Code's
 * compact_boundary records) are counted. A new loop rings the bell once
 * and writes one log line naming the agent; its row says "compacting
 * repeatedly" (session-routes.ts). With agent_context.pause_after_loop,
 * the agent is among the ones Den doesn't type into (typingHeld) until a
 * person clears it on the Agents page.
 */
import { agentPagePath } from "../../shared/agent-links.js";
import {
  agentFilesDir,
  listRecords,
  type AgentRecord,
} from "../../shared/agents/records.js";
import {
  clearCompacting,
  contextWatchSettings,
  instructionWarning,
  readCompacting,
  readInstructionCheck,
  stepCompacting,
  writeCompacting,
  type ContextWatchSettings,
} from "../../shared/agents/context-watch.js";
import type { Compaction } from "../../shared/agents/transcript-follow.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";

/** How often the agents' compactions are looked at: a beat, not a limit. */
const CHECK_MS = 5000;

export interface ContextWatchDeps {
  stateDir: () => string;
  records: () => AgentRecord[];
  settings: () => ContextWatchSettings;
  /** The runtime's compactions for the agent; null: it can't say. */
  compactions: (rec: AgentRecord) => Compaction[] | null;
  store: Pick<NotificationStore, "add">;
  nameOf: (rec: AgentRecord) => string;
  log: (line: string) => void;
  now?: () => number;
}

/** The likely cause, for the log and the row: the start's instruction check when it warned. */
export function likelyCause(stateDir: string, id: string): string | null {
  const c = readInstructionCheck(agentFilesDir(stateDir, id));
  return c?.over ? instructionWarning(c) : null;
}

/** One look at every running agent. Returns the ids whose bell rang. */
export function checkCompactions(d: ContextWatchDeps): string[] {
  const s = d.settings();
  const now = (d.now ?? Date.now)();
  const rang: string[] = [];
  for (const rec of d.records()) {
    if (rec.stoppedAt) continue;
    let list: Compaction[] | null = null;
    try {
      list = d.compactions(rec);
    } catch {
      list = null;
    }
    if (!list) continue;
    const dir = agentFilesDir(d.stateDir(), rec.id);
    const prev = readCompacting(dir);
    const token = rec.resumeToken ?? null;
    const r = stepCompacting(prev, list, token, now, s);
    if (JSON.stringify(r.state) !== JSON.stringify(prev ?? null)) {
      if (r.state.paused !== prev?.paused) pausedSeen = null;
      try {
        writeCompacting(dir, r.state);
      } catch {
        /* the next look tries again; the bell below still rings once */
      }
    }
    if (!r.ring) continue;
    rang.push(rec.id);
    const name = d.nameOf(rec);
    const n = r.state.count ?? 0;
    const m = s.loopMinutes;
    const cause = likelyCause(d.stateDir(), rec.id);
    d.log(
      `⚠ ${name} (${rec.id}) in ${rec.workspace} is compacting repeatedly: ${n} automatic compactions in ${m} minutes` +
        (cause ? `; likely cause: ${cause}` : "") +
        (r.state.paused
          ? "; new deliveries wait until a person clears it on the Agents page"
          : ""),
    );
    try {
      d.store.add({
        kind: "service",
        subject: `agent:${rec.id}`,
        scope: `workspace/${rec.workspace}`,
        text: `${name} is compacting repeatedly: ${n} times in ${m} minutes`,
        msg: { key: "bell.m.compacting", vars: { name, n, m } },
        link: agentPagePath(rec.workspace, rec.id),
      });
    } catch {
      /* the bell is best effort: the log line and the row still say it */
    }
  }
  return rang;
}

/** The last pausedAgents answer: asked on every delivery pump, per agent. */
let pausedSeen: { stateDir: string; at: number; ids: Set<string> } | null =
  null;
const PAUSED_FRESH_MS = 1000;

/** The agents whose deliveries wait for a person (pause_after_loop). */
export function pausedAgents(
  stateDir: string = getStateDir(),
  records: () => AgentRecord[] = () => listRecords(stateDir),
  now: number = Date.now(),
): Set<string> {
  if (
    pausedSeen &&
    pausedSeen.stateDir === stateDir &&
    now - pausedSeen.at < PAUSED_FRESH_MS
  )
    return new Set(pausedSeen.ids);
  const out = new Set<string>();
  try {
    for (const rec of records())
      if (readCompacting(agentFilesDir(stateDir, rec.id))?.paused)
        out.add(rec.id);
  } catch {
    /* records unreadable: nothing held here */
  }
  pausedSeen = { stateDir, at: now, ids: new Set(out) };
  return out;
}

/** A person cleared it on the Agents page: deliveries go again. */
export function clearAgentCompacting(stateDir: string, rec: AgentRecord): void {
  pausedSeen = null;
  writeCompacting(
    agentFilesDir(stateDir, rec.id),
    clearCompacting(rec.resumeToken ?? null),
  );
}

let timer: NodeJS.Timeout | null = null;

/** Start the looks (once). */
export function startContextWatch(o: { log: (line: string) => void }): void {
  if (timer) return;
  let busy = false;
  let deps: ContextWatchDeps | null = null;
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!deps) {
        const { getRuntime } = await import("../../shared/agents/runtimes.js");
        const { readUserConfig } = await import("../../shared/den-config.js");
        const { notificationDeps } = await import("./notification-service.js");
        const { webDeps } = await import("./agent-routes.js");
        const wd = webDeps();
        deps = {
          stateDir: getStateDir,
          records: () => listRecords(getStateDir()),
          settings: () => {
            try {
              return contextWatchSettings(readUserConfig().agent_context);
            } catch {
              return contextWatchSettings(undefined);
            }
          },
          compactions: (rec) => {
            let readMaxBytes: number | undefined;
            try {
              readMaxBytes = wd.agentsConfig().turnReadMaxBytes;
            } catch {
              readMaxBytes = undefined;
            }
            return (
              getRuntime(rec.runtime)?.compactions?.(rec, wd.env, {
                readMaxBytes,
              }) ?? null
            );
          },
          store: notificationDeps().store,
          nameOf: (rec) => rec.displayName || rec.persona || rec.id,
          log: o.log,
        };
      }
      checkCompactions(deps);
    } catch {
      /* the next beat tries again */
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void beat(), CHECK_MS);
  timer.unref();
}
