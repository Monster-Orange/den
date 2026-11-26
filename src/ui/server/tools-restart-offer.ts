import type { DenToolsOld } from "../../shared/agents/den-tools-version.js";
import type { DetailKey } from "../../shared/review-lines.js";
import {
  AGENT_RESTART_SELF_ACTION,
  type RestartSelfCheck,
} from "../../shared/agents/restart-self.js";

export interface ToolsRestartOfferDeps {
  stale: () => Promise<
    {
      id: string;
      workspace: string;
      stale: { adds: string[]; drops: string[]; den?: DenToolsOld };
    }[]
  >;
  pending: () => { action: string; args: Record<string, unknown> }[];
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
  }) => { id: string };
}

export const TOOLS_RESTART_ACTOR = "den:tools-update";

export async function offerToolsRestarts(
  d: ToolsRestartOfferDeps,
): Promise<string[]> {
  let stale: Awaited<ReturnType<ToolsRestartOfferDeps["stale"]>>;
  try {
    stale = await d.stale();
  } catch {
    return [];
  }
  const waiting = new Set(
    d
      .pending()
      .filter((a) => a.action === AGENT_RESTART_SELF_ACTION)
      .map((a) => String(a.args.agent ?? "")),
  );
  const offered: string[] = [];
  for (const a of stale) {
    if (!a.stale.den || waiting.has(a.id)) continue;
    try {
      const c = await d.check({
        agent: a.id,
        project: a.workspace,
        reason: "update",
      });
      if (!c.ok) continue;
      d.request({
        actor: `${TOOLS_RESTART_ACTOR}:${a.workspace}/${a.id}`,
        action: AGENT_RESTART_SELF_ACTION,
        args: c.args as unknown as Record<string, unknown>,
        summary: c.summary,
        params: c.params,
        details: c.details,
        detailKeys: c.detailKeys,
      });
      offered.push(a.id);
    } catch {
      continue;
    }
  }
  return offered;
}
