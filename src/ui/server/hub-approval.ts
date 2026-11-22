/**
 * P0-D2: an owner's approval arrived (the delivery loop's `approved`). The
 * agent's open question about that doc or held write goes, and so does
 * the question of another agent in the same Den project that names it:
 * Den tells that agent, with an item of its own (never acked to Hub).
 */
import {
  approvalKeys,
  approvalNoticeText,
  LOCAL_PREFIX,
  type Delivery,
  type DeliveryOwner,
} from "../../shared/hub-delivery.js";

export interface SettleDeps {
  approvedAbout: (agent: string, workspace: string, keys: string[]) => string[];
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
  const others = d.approvedAbout(dv.agent, ws, approvalKeys(dv));
  for (const agent of others)
    await d.takeLocal({
      ...dv,
      id: `${LOCAL_PREFIX}approval:${dv.id}:${agent}`,
      agent,
      text: approvalNoticeText(dv, o),
    });
}
