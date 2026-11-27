import type { Notification } from "../../shared/notifications.js";
import type { DetailKey } from "../../shared/review-lines.js";
import {
  AGENT_RESTART_SELF_ACTION,
  type RestartSelfCheck,
} from "../../shared/agents/restart-self.js";
import { rowWhy } from "./attention.js";

const SAYS_RESTART = /restart|再起動/i;
const SAYS_TOOLS = /\btools?\b|ツール/i;

export const FREE_TEXT_ACTOR = "den:free-text";

export function asksForToolsRestart(text: string): boolean {
  return SAYS_RESTART.test(text) && SAYS_TOOLS.test(text);
}

export interface FreeTextRestartDeps {
  rows: () => readonly Notification[];
  pending: () => { action: string; args: Record<string, unknown> }[];
  askedBefore: (actor: string) => boolean;
  check: (
    args: Record<string, unknown>,
  ) => RestartSelfCheck | Promise<RestartSelfCheck>;
  request: (r: {
    actor: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
    params?: Record<string, string>;
    details?: string[];
    detailKeys?: DetailKey[];
    note?: string;
  }) => { id: string };
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
      const c = await d.check({ agent: id, reason: "tools" });
      if (!c.ok) continue;
      const actor = `${FREE_TEXT_ACTOR}:${c.args.project}/${id}`;
      if (d.askedBefore(actor)) continue;
      d.request({
        actor,
        action: AGENT_RESTART_SELF_ACTION,
        args: c.args as unknown as Record<string, unknown>,
        summary: c.summary,
        params: c.params,
        details: c.details,
        detailKeys: c.detailKeys,
        note: `From ${id}'s question: ${text}`,
      });
      waiting.add(id);
      matched.push(id);
    } catch {
      continue;
    }
  }
  return matched;
}
