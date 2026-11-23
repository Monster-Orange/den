/**
 * Issue 113 (AGENT-ORG, TUNE-5): messages to another project's agents that
 * went around that project's lead. Across projects, a message goes to the
 * other project's lead (a persona whose role is in LEAD_ROLES), who answers
 * it or forwards it; Den's policy is to advise, so the Coach reports these
 * and names the lead, and changes nothing.
 *
 * A send's "to" is what SendMessage was given: a session's name,
 * `<dist>-<project>:<name>` with an optional ` [ref]`, or a bare name. It is
 * matched to this Den's own agents by project and by name (display name or
 * id, any case). A target Den doesn't know, such as another install's
 * agent, is never counted.
 */
import { LEAD_ROLES } from "../agents/lead-roles.js";
import type { SendSeen } from "./asks.js";

/** An agent of this Den, as the Coach sees who leads what. */
export interface OrgAgent {
  id: string;
  /** Its display name, when it has one. */
  name?: string;
  workspace: string;
  /** Its persona's role, when it has one. */
  role?: string;
}

const fold = (s: string) => s.trim().toLowerCase();
const isLead = (a: OrgAgent) => LEAD_ROLES.includes(a.role ?? "");
const named = (a: OrgAgent, name: string) =>
  fold(a.id) === name || (a.name !== undefined && fold(a.name) === name);

/** The agent `to` names, or undefined when it isn't exactly one of `org`. */
export function targetOf(
  to: string,
  org: readonly OrgAgent[],
): OrgAgent | undefined {
  const raw = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (!raw) return undefined;
  const colon = raw.lastIndexOf(":");
  const name = fold(colon >= 0 ? raw.slice(colon + 1) : raw);
  if (!name) return undefined;
  let found: OrgAgent[];
  if (colon >= 0) {
    // `<dist>-<project>`: the project is a suffix after a dash (a project
    // may have dashes of its own), or the whole prefix.
    const prefix = raw.slice(0, colon);
    found = org.filter(
      (a) =>
        (prefix === a.workspace || prefix.endsWith(`-${a.workspace}`)) &&
        named(a, name),
    );
  } else found = org.filter((a) => named(a, name));
  return found.length === 1 ? found[0] : undefined;
}

export interface LeadSkips {
  /** Sends to a known agent of another project. */
  cross: number;
  /** Of those, the ones to a project with a lead, not to the lead. */
  skipped: SendSeen[];
  /** Each skipped project's lead (its display name, else its id). */
  leads: Record<string, string>;
}

/** `from`'s sends that went around another project's lead. */
export function leadSkips(
  sends: readonly SendSeen[],
  from: OrgAgent,
  org: readonly OrgAgent[],
): LeadSkips {
  const out: LeadSkips = { cross: 0, skipped: [], leads: {} };
  for (const s of sends) {
    const to = targetOf(s.to, org);
    if (!to || to.workspace === from.workspace) continue;
    out.cross++;
    if (isLead(to)) continue;
    const leads = org
      .filter((a) => a.workspace === to.workspace && isLead(a))
      .sort((x, y) => x.id.localeCompare(y.id));
    if (!leads.length) continue;
    out.skipped.push(s);
    out.leads[to.workspace] = leads[0].name ?? leads[0].id;
  }
  return out;
}
