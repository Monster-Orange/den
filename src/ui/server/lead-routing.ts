/**
 * Issue 101, lead routing: an agent's question (ask_human, or a turn that
 * ended on one) goes to its project's lead, not to the person's "Needs
 * you"; the lead sends the person only what needs them (its own
 * ask_human). A project's lead is a running agent in it whose persona's
 * role is "lead" or Den's "orchestrator", the longest running first. No
 * lead, the asker a lead itself, or a lead Den can't type to: the person,
 * as before. A permission prompt always goes to the person: only they can
 * allow it.
 *
 * This is not the lead install (LEAD-1, update-check.ts): that is which
 * Den moves a distribution's pin.
 */
import { listRecords, type AgentRecord } from "../../shared/agents/records.js";
import { getStateDir } from "../../shared/paths.js";
import { LEAD_ROLES } from "../../shared/agents/lead-roles.js";

/** The persona roles that lead a project's agents (shared with the Coach). */
export { LEAD_ROLES };

/** An agent as lead routing sees it. */
export interface LeadCandidate {
  id: string;
  workspace: string;
  /** Its persona's role, when it has one. */
  role?: string;
  running: boolean;
  /** ISO 8601. */
  startedAt: string;
}

/** The lead of `workspace` for `asker`'s question, or null (the person). */
export function pickLead(
  all: readonly LeadCandidate[],
  workspace: string,
  asker: string,
): string | null {
  const leads = all.filter(
    (a) =>
      a.workspace === workspace &&
      a.running &&
      LEAD_ROLES.includes(a.role ?? ""),
  );
  // A lead's own question goes to the person.
  if (leads.some((a) => a.id === asker)) return null;
  leads.sort(
    (x, y) =>
      x.startedAt.localeCompare(y.startedAt) || x.id.localeCompare(y.id),
  );
  return leads[0]?.id ?? null;
}

/** What Den types to the lead: one line (Enter sends it). */
export function leadAskText(
  name: string,
  agent: string,
  question: string,
): string {
  const q = question.replace(/\s+/g, " ").trim();
  return (
    `Den: ${name} (agent ${agent}) in your project asked: "${q}". ` +
    `You are this project's lead, so it came to you, not to your person. ` +
    `If it needs a person's decision, ask them with ask_human and name ${name}; ` +
    `otherwise decide it and tell ${name} through its work item or pull request.`
  );
}

/** The candidates from this Den's agent records (Den's own wiring). */
export async function leadCandidates(): Promise<LeadCandidate[]> {
  const [{ webDeps }, { personaLookup }] = await Promise.all([
    import("./agent-routes.js"),
    import("../cli/agent-ops.js"),
  ]);
  const d = webDeps();
  const records = listRecords(getStateDir()).filter(
    (r: AgentRecord) => !r.stoppedAt,
  );
  let live: Set<string> | null = null;
  const c = await d.connectExisting().catch(() => null);
  if (c)
    try {
      live = new Set(
        (await c.list()).filter((x) => !x.exited).map((x) => x.ref.id),
      );
    } finally {
      c.close();
    }
  if (!live) return [];
  const find = personaLookup(d);
  return records.map((r) => ({
    id: r.id,
    workspace: r.workspace,
    role: find(r)?.role,
    running: live.has(r.session.id),
    startedAt: r.startedAt,
  }));
}

/** Type `text` to agent `lead`; false when Den couldn't. Never throws. */
export async function tellLead(lead: string, text: string): Promise<boolean> {
  try {
    const [{ webDeps }, ops] = await Promise.all([
      import("./agent-routes.js"),
      import("../cli/agent-ops.js"),
    ]);
    return await ops.typeIntoAgent(webDeps(), lead, text);
  } catch {
    return false;
  }
}
