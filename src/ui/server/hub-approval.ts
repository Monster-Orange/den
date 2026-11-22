/**
 * P0-D2: an owner's approval arrived (the delivery loop's `approved`). The
 * agent's open question about that doc or held write goes, and so does
 * the question of another agent in the same Den project that names it:
 * Den tells that agent, with an item of its own (never acked to Hub).
 */
import {
  approvalKeys,
  approvalNoticeText,
  approvalVersion,
  LOCAL_PREFIX,
  type Delivery,
  type DeliveryOwner,
} from "../../shared/hub-delivery.js";

export interface SettleDeps {
  approvedAbout: (
    agent: string,
    workspace: string,
    keys: string[],
    version?: number,
  ) => { agent: string; key: string }[];
  /** An audit line per question cleared: who, which delivery, which key. */
  log: (line: string) => void;
  /** The agent's Den project, or null when Den has no record of it. */
  workspaceOf: (agent: string) => string | null;
  owner: () => DeliveryOwner | null;
  takeLocal: (dv: Delivery) => Promise<boolean>;
}

export async function settleApproval(
  dv: Delivery,
  d: SettleDeps,
): Promise<void> {
  const ws = d.workspaceOf(dv.agent);
  const o = d.owner();
  if (!ws || !o) return;
  for (const c of d.approvedAbout(
    dv.agent,
    ws,
    approvalKeys(dv),
    approvalVersion(dv),
  )) {
    const other = c.agent !== dv.agent;
    d.log(
      `hub approval: cleared ${c.agent}'s question (delivery ${dv.id}, kind ${dv.kind ?? "comment"}, names ${c.key})${other ? "; told it" : ""}`,
    );
    if (other)
      await d.takeLocal({
        ...dv,
        id: `${LOCAL_PREFIX}approval:${dv.id}:${c.agent}`,
        agent: c.agent,
        text: approvalNoticeText(dv, o),
      });
  }
}
