import type { NoteMsg, Notification } from "../../shared/notifications.js";
import type { DetailKey } from "../../shared/review-lines.js";
import {
  AGENT_RESTART_SELF_ACTION,
  type RestartSelfCheck,
} from "../../shared/agents/restart-self.js";
import { rowWhy } from "./attention.js";

const SAYS_RESTART = /restart|再起動/i;
const SAYS_TOOLS = /\btools?\b|ツール/i;

export function asksForToolsRestart(text: string): boolean {
  return SAYS_RESTART.test(text) && SAYS_TOOLS.test(text);
}

export interface FreeTextRestartDeps {
  rows: () => readonly Notification[];
  pending: () => { action: string; args: Record<string, unknown> }[];
  check: (
    args: Record<string, unknown>,
    who: { agent: string },
  ) => RestartSelfCheck | Promise<RestartSelfCheck>;
  request: (r: {
    actor: string;
    agent: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
    params?: Record<string, string>;
    details?: string[];
    detailKeys?: DetailKey[];
  }) => { id: string };
  settle: (
    id: string,
    s: { reason: string; by: string },
    say: { text: string; msg: NoteMsg },
  ) => unknown;
}

export async function matchFreeTextRestarts(
  d: FreeTextRestartDeps,
): Promise<string[]> {
  const waiting = new Set(
    d
      .pending()
      .filter((a) => a.action === AGENT_RESTART_SELF_ACTION)
      .map((a) => String(a.args.agent ?? "")),
  );
  const matched: string[] = [];
  for (const n of d.rows()) {
    if (n.kind !== "waiting" || n.read || n.settled) continue;
    if (!n.subject.startsWith("agent:") || rowWhy(n) !== "asked") continue;
    const id = n.subject.slice("agent:".length);
    const text = String(n.msg?.vars?.text ?? n.text);
    if (!id || waiting.has(id) || !asksForToolsRestart(text)) continue;
    try {
      const c = await d.check({ reason: "tools" }, { agent: id });
      if (!c.ok) continue;
      d.request({
        actor: `agent:${id}`,
        agent: id,
        action: AGENT_RESTART_SELF_ACTION,
        args: c.args as unknown as Record<string, unknown>,
        summary: c.summary,
        params: c.params,
        details: c.details,
        detailKeys: c.detailKeys,
      });
      waiting.add(id);
      matched.push(id);
      d.settle(
        n.id,
        { reason: "in the restart card", by: "den" },
        {
          text: `${id} asked to be restarted for new tools: it's in the restart card now`,
          msg: { key: "bell.m.rsMatched", vars: { id } },
        },
      );
    } catch {
      continue;
    }
  }
  return matched;
}
