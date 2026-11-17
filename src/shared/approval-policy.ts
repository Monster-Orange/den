/**
 * Issue 160: the approval policy. Which of an agent's held writes need the
 * person's Allow, and which run at once.
 *
 * The person gets an Allow only for a real decision. A held write that
 * widens what an agent may do is critical: it always waits for the
 * person's own Allow, and no setting lowers it. Every other held write is
 * routine: it follows the policy, one of
 *
 *   auto    runs at once; the activity trail has it
 *   notify  runs at once; the trail has it, and the person's updates say
 *           what ran (the default)
 *   ask     waits for the person's Allow, as before
 *
 * The policy is a setting: `approvals:` in the person's
 * config/local/user.yml (the install's), and `<project>.approvals:` in
 * config/local/workspaces.yml (a project's, over the install's):
 *
 *   approvals:
 *     policy: notify        # auto | notify | ask, for every routine write
 *     writes:               # one write's own, over `policy`
 *       repo_clone: ask
 *
 * An agent may still ask for any write (`ask: true` with a `note` saying
 * why): it then waits for the Allow whatever the policy says.
 */

export type PolicyKind = "auto" | "notify" | "ask";
export const POLICY_KINDS: readonly PolicyKind[] = ["auto", "notify", "ask"];

/** A routine write's kind when nothing is set: done, and the person told. */
export const DEFAULT_POLICY: PolicyKind = "notify";

/**
 * How a held write is judged:
 *   critical  always the person's Allow (it widens what an agent may do)
 *   widens    critical when its check says it widens (`personOnly`, e.g.
 *             a mode toward a looser one), else routine
 *   routine   the policy
 */
export type HeldWriteRisk = "critical" | "widens" | "routine";

/**
 * Issue 160 (Vision, binding): the critical list, in one place. Each held
 * write, how it is judged and why. A write not named here is critical:
 * a new held write asks until someone places it.
 */
export const HELD_WRITE_RISK: Readonly<
  Record<string, { risk: HeldWriteRisk; why: string }>
> = {
  project_mode: {
    risk: "widens",
    why: "a looser mode lets agents act without asking; a stricter one only narrows",
  },
  agent_mode: {
    risk: "widens",
    why: "following a looser project mode widens the agent; a stricter one narrows",
  },
  project_mcp_add: {
    risk: "critical",
    why: "gives a project's agents new tools, and sends a bearer to a new address",
  },
  persona_create: {
    risk: "critical",
    why: "a persona carries a mode and commands it may run: new tool access",
  },
  persona_update: {
    risk: "critical",
    why: "a persona carries a mode and commands it may run: new tool access",
  },
  hub_connect: {
    risk: "critical",
    why: "points Den at another Hub, or none: where agents publish and read",
  },
  den_update: {
    risk: "critical",
    why: "installs another Den version (a release)",
  },
  den_restart: {
    risk: "critical",
    why: "restarts Den for every project; server_agent.self_update decides for Den's own agent",
  },
  agent_create: {
    risk: "routine",
    why: "starts an agent in the project's mode or a stricter one",
  },
  agent_folder: { risk: "routine", why: "moves an agent within its project" },
  workspace_create: { risk: "routine", why: "adds an empty project" },
  repo_add: {
    risk: "critical",
    why: "gives the project's agents a repo they couldn't reach: wider access",
  },
  repo_clone: { risk: "routine", why: "clones a repo into a new folder" },
  den_pin_commit: {
    risk: "routine",
    why: "commits and pushes the distribution's new Den pin (package.json, package-lock.json), nothing else",
  },
  service_try: { risk: "routine", why: "starts a service locally" },
  verify_run: {
    risk: "critical",
    why: "runs checks against a shared environment (CRITICAL_HELD_ACTIONS)",
  },
};

/**
 * Whether held write `action` is critical: named so, or one that widens
 * and whose check says this ask widens. Unknown writes are critical.
 */
export function isCriticalWrite(action: string, widens: boolean): boolean {
  const r = Object.hasOwn(HELD_WRITE_RISK, action)
    ? HELD_WRITE_RISK[action].risk
    : "critical";
  return r === "critical" || (r === "widens" && widens);
}

/** One level's setting (`approvals:`), checked. */
export interface PolicySetting {
  policy?: PolicyKind;
  writes?: Record<string, PolicyKind>;
}

function kindOf(v: unknown, key: string): PolicyKind {
  if (typeof v === "string" && (POLICY_KINDS as string[]).includes(v))
    return v as PolicyKind;
  throw new Error(
    `${key}: auto, notify or ask, not ${JSON.stringify(v) ?? "nothing"}`,
  );
}

/**
 * `approvals:` as written, checked; undefined when unset. A bad value
 * throws, naming the key: the caller holds the write then (never runs it
 * unasked on a typo).
 */
export function readPolicySetting(
  raw: unknown,
  key = "approvals",
): PolicySetting | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${key}: a mapping with policy and writes`);
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== "policy" && k !== "writes");
  if (extra.length) throw new Error(`${key}: unknown key ${extra.join(", ")}`);
  const out: PolicySetting = {};
  if (r.policy !== undefined && r.policy !== null)
    out.policy = kindOf(r.policy, `${key}.policy`);
  if (r.writes !== undefined && r.writes !== null) {
    if (typeof r.writes !== "object" || Array.isArray(r.writes))
      throw new Error(`${key}.writes: a mapping of held write to kind`);
    out.writes = {};
    for (const [w, v] of Object.entries(r.writes as Record<string, unknown>))
      out.writes[w] = kindOf(v, `${key}.writes.${w}`);
  }
  return out;
}

/**
 * The kind a held write follows, with where it came from. Critical: always
 * ask (no setting lowers it). Else the project's own setting for this
 * write, its policy, the install's for this write, its policy, the
 * default.
 */
export function policyFor(
  action: string,
  o: { widens?: boolean; install?: PolicySetting; project?: PolicySetting },
): { kind: PolicyKind; from: string } {
  if (isCriticalWrite(action, o.widens === true))
    return { kind: "ask", from: "critical" };
  const own = (s: PolicySetting | undefined) =>
    s?.writes && Object.hasOwn(s.writes, action) ? s.writes[action] : undefined;
  const p = own(o.project);
  if (p) return { kind: p, from: `project approvals.writes.${action}` };
  if (o.project?.policy)
    return { kind: o.project.policy, from: "project approvals.policy" };
  const i = own(o.install);
  if (i) return { kind: i, from: `approvals.writes.${action}` };
  if (o.install?.policy)
    return { kind: o.install.policy, from: "approvals.policy" };
  return { kind: DEFAULT_POLICY, from: "default" };
}
