/**
 * Issue 160: the approval policy. Which of an agent's held writes need the
 * person's Allow, and which run at once.
 *
 * The person gets an Allow only for a real decision. A held write that
 * widens what an agent may do is critical: it always waits for the
 * person's own Allow, and no setting lowers it. Every other held write is
 * routine: it follows the policy, one of
 *
 * Issue 1391's rule (Den Builder): a check that says personOnly ("this one
 * is the person's") always asks, on every install mode, kept or not, and
 * whatever the policy. A check that should be routine on a personal
 * install stops saying personOnly there itself (newAgentSandboxOff,
 * settingKind); the ask path never drops it (criticalWhy).
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
 *     watch:                # what the person watches: a write on it asks
 *       - project:north     #   project:, repo:, service:, persona:,
 *       - repo:api          #   agent:, or a bare name (any of them)
 *     critical:             # kinds of write that always ask here
 *       - service_try
 *
 * Issue 160 (0.4.65): a write asks, whatever its kind, when
 *   - it is critical: it widens what an agent may do, or it touches
 *     secrets, deletes data or spends money (CRITICAL_AREAS);
 *   - the project's (or the install's) `critical` list names it;
 *   - it is on something the person watches (`watch`) or pinned to the
 *     rail (their favorites, user.yml shell.pins);
 *   - it changes the approval policy itself (approval_policy): only a
 *     person in the page changes it without an Allow.
 *
 * An agent may still ask for any write (`ask: true` with a `note` saying
 * why): it then waits for the Allow whatever the policy says.
 */

import type { InstallMode } from "./den-config.js";

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
 * Issue 160: what makes a write critical by what it touches, whatever its
 * placement: secrets, deletes of data, money. A held write's check may say
 * so (`areas`), and so do its placement and its own name (`areasOf`). A
 * placed write leaves a name's area only by declaring it (`notAreas`,
 * issue 1403): project_mcp_remove's "remove" deletes no data.
 */
export type CriticalArea = "secrets" | "deletes" | "money";
export const CRITICAL_AREAS: Readonly<
  Record<CriticalArea, { name: RegExp; why: string }>
> = {
  secrets: {
    name: /(^|_)(secret|secrets|token|tokens|credential|credentials|password|passwords)($|_)/,
    why: "reads or changes a secret",
  },
  deletes: {
    name: /(^|_)(delete|remove|drop|purge|wipe|destroy|erase)($|_)/,
    why: "deletes data",
  },
  money: {
    name: /(^|_)(pay|payment|charge|purchase|billing|invoice|refund|spend|money)($|_)/,
    why: "spends money",
  },
};

/** The critical areas a write's own name says it touches. */
export function areasOf(action: string): CriticalArea[] {
  return (Object.keys(CRITICAL_AREAS) as CriticalArea[]).filter((a) =>
    CRITICAL_AREAS[a].name.test(action),
  );
}

/**
 * Issue 160 (Vision, binding): the critical list, in one place. Each held
 * write, how it is judged and why. A write not named here is critical:
 * a new held write asks until someone places it.
 */
export const HELD_WRITE_RISK: Readonly<
  Record<
    string,
    {
      risk: HeldWriteRisk;
      why: string;
      /** What it touches (CRITICAL_AREAS): critical whatever `risk` says. */
      areas?: CriticalArea[];
      /**
       * Issue 1403 (Reviewer D): an area its name says that it doesn't
       * touch, declared here, on its own entry (project_mcp_remove takes
       * tools away; it deletes no data). Without it the name's area holds.
       */
      notAreas?: CriticalArea[];
      /**
       * Issue 160: the kind it follows when no setting names it. Ask is
       * stricter than any `policy`; only `writes.<it>` lowers it. A looser
       * one gives way to a stricter `policy`.
       */
      kind?: PolicyKind;
      /**
       * Issue 1391: "keep" when it still asks on a personal install, as on a
       * strict one: real security (the sandbox, approvals, credentials,
       * who may sign in, exposure) or acting on others. Every other placed
       * write is routine on a personal install; secrets, deletes and money
       * (its areas) are critical on both.
       */
      personal?: "keep";
    }
  >
> = {
  project_mode: {
    personal: "keep",
    risk: "widens",
    why: "a looser mode lets agents act without asking; a stricter one only narrows",
  },
  project_agent_cap: {
    personal: "keep",
    risk: "widens",
    why: "a higher cap lets more of a project's agents run at once; a lower one only narrows",
  },
  agent_mode: {
    personal: "keep",
    risk: "widens",
    why: "following a looser project mode widens the agent; a stricter one narrows",
  },
  setting_change: {
    personal: "keep",
    risk: "widens",
    kind: "ask",
    why: "a setting that widens what agents can do needs the person's own Allow (issue 1371); every other one asks until the person chooses per category",
  },
  gate_settings_set: {
    risk: "widens",
    why: "the gate's settings are scheduling on the person's own machine: routine limits, so they follow the person's choice for Limits and performance (issue 1395)",
  },
  agent_sandbox_set: {
    personal: "keep",
    risk: "widens",
    why: "an agent out of the sandbox can write Den's own files (issue 1328); back in only narrows",
  },
  project_mcp_add: {
    personal: "keep",
    risk: "critical",
    why: "gives a project's agents new tools, and sends a bearer to a new address",
  },
  project_mcp_remove: {
    risk: "critical",
    notAreas: ["deletes"],
    why: "takes tools away from a project's agents at their next start (issue 352: the person's own Allow); it narrows, so routine on a personal install (issue 1403)",
  },
  project_mcp_update: {
    personal: "keep",
    risk: "critical",
    why: "sends a project's agents' calls, and maybe a bearer, to another address",
  },
  project_event_feed_add: {
    risk: "critical",
    why: "has Den open an app's stream for one of a project's agents, a bearer read by its secrets.refs name; routine on a personal install, with Undo (issue 1480)",
  },
  project_event_feed_remove: {
    risk: "critical",
    notAreas: ["deletes"],
    why: "stops an app's events reaching a project's agent; it deletes no events; routine on a personal install, with Undo (issue 1480)",
  },
  persona_create: {
    risk: "critical",
    why: "a persona carries a mode and commands it may run: new tool access; on a personal install with nothing sandboxed, routine (issue 1403)",
  },
  persona_update: {
    risk: "critical",
    why: "a persona carries a mode and commands it may run: new tool access; on a personal install with nothing sandboxed, routine (issue 1403)",
  },
  hub_connect: {
    personal: "keep",
    risk: "critical",
    why: "points Den at another Hub, or none: where agents publish and read",
  },
  den_update: {
    risk: "critical",
    why: "installs another Den version (a release); on a personal install routine unless server_agent.self_update: ask (issue 1403)",
  },
  den_restart: {
    risk: "critical",
    why: "restarts Den for every project; server_agent.self_update decides for Den's own agent",
  },
  hub_project_create: {
    personal: "keep",
    risk: "routine",
    why: "asks Hub for a new project; an owner decides it in Hub, and the link only files work",
  },
  hub_link: {
    risk: "routine",
    kind: "ask",
    why: "moves where a project's agents file their Hub work: asks unless the person lowers it; routine on a personal install (issue 1403)",
  },
  agent_create: {
    risk: "widens",
    why: "starts an agent in the project's mode or a stricter one; one that would start outside the sandbox is the person's (issue 1328)",
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
  den_sandbox_on: {
    risk: "routine",
    why: "puts agents from before the agent sandbox into it: it narrows what they may do",
  },
  service_try: { risk: "routine", why: "starts a service locally" },
  verify_run: {
    personal: "keep",
    risk: "critical",
    why: "runs checks against a shared environment (CRITICAL_HELD_ACTIONS)",
  },
  embed_key_create: {
    personal: "keep",
    risk: "critical",
    why: "lets a web app message an agent and read its state; a person's own ask",
  },
  embed_key_revoke: {
    personal: "keep",
    risk: "critical",
    why: "a person's own ask, from Settings › Embedding",
  },
  gate_runner_token_create: {
    personal: "keep",
    risk: "critical",
    areas: ["secrets"],
    why: "makes a token a CI runner uses to take gate slots on this machine",
  },
  gate_box_set: {
    personal: "keep",
    risk: "critical",
    why: "adds or changes a test box whose browsers take agents' gate runs (CRITICAL_HELD_ACTIONS)",
  },
  gate_box_remove: {
    risk: "critical",
    notAreas: ["deletes"],
    why: "removes a test box: a person's own Allow (CRITICAL_HELD_ACTIONS); on a personal install routine, since a box can be added back (issue 1403)",
  },
  web_url_set: {
    personal: "keep",
    risk: "critical",
    why: "changes the address every link, sign-in and Hub uses for this Den: a person's own Allow",
  },
  gate_runner_entry_set: {
    risk: "critical",
    why: "lets a repo's CI jobs run on a test box: it widens what runs there",
  },
  host_restart: {
    risk: "critical",
    why: "restarts the terminal host every agent runs in; a turn still going when the wait runs out is cut",
  },
  test_person_setup: {
    personal: "keep",
    risk: "critical",
    why: "gives a test install on this computer its test person, which its live checks sign in as: a person's own Allow (CRITICAL_HELD_ACTIONS)",
  },
  approval_policy: {
    personal: "keep",
    risk: "critical",
    why: "changes the approval policy itself: a person's only",
  },
  agent_import: {
    risk: "widens",
    kind: "ask",
    why: "brings a conversation started outside Den in as an agent: asks unless the person lowers it; one that would start outside the sandbox is the person's (issue 1328)",
  },
  pr_close: {
    personal: "keep",
    risk: "routine",
    kind: "auto",
    why: "closes a stale or superseded PR after a Hub note: runs unless watched",
  },
  report: {
    personal: "keep",
    risk: "widens",
    why: "files a report on GitHub as the person: to a public (or not known) repository it is visible to everyone, so the person's own Allow; to a private one the policy",
  },
};

/**
 * Why held write `action` is critical ("critical", or "critical: <area>"),
 * or null when it is routine: it touches secrets, deletes or money (its
 * name, its placement or its check's `areas` say so; a placed write may
 * opt out of its name's area with `notAreas`), it is named critical, or it widens and its check says this ask widens. Unknown
 * writes are critical.
 */
export function criticalWhy(
  action: string,
  widens: boolean,
  areas: readonly CriticalArea[] = [],
  /** Issue 1391: the install's mode; strict when not given. */
  mode: InstallMode = "strict",
): string | null {
  const placed = Object.hasOwn(HELD_WRITE_RISK, action)
    ? HELD_WRITE_RISK[action]
    : undefined;
  const touches = [
    ...new Set([
      ...areasOf(action).filter((a) => !placed?.notAreas?.includes(a)),
      ...(placed?.areas ?? []),
      ...areas,
    ]),
  ].filter((a) => Object.hasOwn(CRITICAL_AREAS, a));
  if (touches.length) return `critical: ${touches.join(", ")}`;
  // Issue 1391's rule: the check said personOnly, so the person's, on
  // every mode (see the header).
  if (widens) return "critical";
  // Issue 1391: a placed write is routine on a personal install unless it
  // is real security or acts on others. One no one placed still asks.
  if (mode === "personal" && placed && placed.personal !== "keep") return null;
  const r = placed ? placed.risk : "critical";
  return r === "critical" ? "critical" : null;
}

/** Whether held write `action` is critical (criticalWhy). */
export function isCriticalWrite(
  action: string,
  widens: boolean,
  areas: readonly CriticalArea[] = [],
  mode: InstallMode = "strict",
): boolean {
  return criticalWhy(action, widens, areas, mode) !== null;
}

/**
 * Issue 1371 Part 2: the kinds of setting an agent may ask to change
 * (setting_change), each with its severity. setting-change.ts settingKind
 * places each key.
 */
export type SettingCategory =
  | "limits"
  | "look"
  | "integrations"
  | "network"
  | "agent_powers";
export const SETTING_CATEGORIES: readonly SettingCategory[] = [
  "limits",
  "look",
  "integrations",
  "network",
  "agent_powers",
];
/**
 * The person's choice per category, Settings › Approvals › Agents changing
 * settings: auto (change without asking, and tell me), ask, or never.
 */
export type SettingChoice = "auto" | "ask" | "never";
export const SETTING_CHOICES: readonly SettingChoice[] = [
  "auto",
  "ask",
  "never",
];

/**
 * The choice when the person made none. Limits and look change without
 * asking; network and agent powers ask. Integrations (editors, runtimes,
 * Hub, GitHub) ask on a strict install and change at once on a personal
 * one (issue 1391).
 */
export function settingChoiceDefault(
  category: SettingCategory,
  mode: InstallMode = "strict",
): SettingChoice {
  // Den Builder's ruling: strict keeps today's asks for every category
  // (a person may set one to auto); change-and-tell is personal's default.
  if (mode !== "personal") return "ask";
  if (category === "limits" || category === "look") return "auto";
  if (category === "integrations") return "auto";
  return "ask";
}

/**
 * The choice that applies to a category: the person's (approvals.settings),
 * else the default for the install's mode, with where it came from. Agent
 * powers never change without asking.
 */
export function settingChoice(
  category: SettingCategory,
  mode: InstallMode = "strict",
  set?: PolicySetting["settings"],
): { choice: SettingChoice; from: string } {
  const mine = set && Object.hasOwn(set, category) ? set[category] : undefined;
  if (mine) return { choice: mine, from: `approvals.settings.${category}` };
  return {
    choice: settingChoiceDefault(category, mode),
    from: `${mode} install's default for ${category}`,
  };
}

/** One level's setting (`approvals:`), checked. */
export interface PolicySetting {
  /**
   * Issue 1371 Part 2: per category, whether an agent's setting_change runs
   * without asking, asks, or is refused. agent_powers: ask or never.
   */
  settings?: Partial<Record<SettingCategory, SettingChoice>>;
  policy?: PolicyKind;
  writes?: Record<string, PolicyKind>;
  /** Issue 160: what the person watches (WATCH_RE): a write on it asks. */
  watch?: string[];
  /** Issue 160: kinds of write that always ask at this level. */
  critical?: string[];
}

/** A watched item: `<kind>:<name>`, or a bare name (any kind). */
export const WATCH_KINDS = [
  "project",
  "repo",
  "service",
  "persona",
  "agent",
] as const;
export const WATCH_RE =
  /^(?:(?:project|repo|service|persona|agent):)?[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** A held write's kind, as a critical list names it. */
export const WRITE_KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** How many a watch or critical list keeps (a guard, not a limit). */
export const MAX_POLICY_LIST = 500;

function listOf(v: unknown, key: string, re: RegExp, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${key}: a list of ${what}`);
  if (v.length > MAX_POLICY_LIST)
    throw new Error(`${key}: at most ${MAX_POLICY_LIST}`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !re.test(x.trim()))
      throw new Error(`${key}: ${JSON.stringify(x)} is not ${what}`);
    if (!out.includes(x.trim())) out.push(x.trim());
  }
  return out;
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
  const extra = Object.keys(r).filter(
    (k) => !["policy", "writes", "watch", "critical", "settings"].includes(k),
  );
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
  if (r.watch !== undefined && r.watch !== null)
    out.watch = listOf(
      r.watch,
      `${key}.watch`,
      WATCH_RE,
      "a watched item (project:, repo:, service:, persona:, agent: or a name)",
    );
  if (r.settings !== undefined && r.settings !== null) {
    if (typeof r.settings !== "object" || Array.isArray(r.settings))
      throw new Error(`${key}.settings: a mapping of category to choice`);
    out.settings = {};
    for (const [c, v] of Object.entries(
      r.settings as Record<string, unknown>,
    )) {
      if (!(SETTING_CATEGORIES as string[]).includes(c))
        throw new Error(
          `${key}.settings: ${JSON.stringify(c)} is not a category (${SETTING_CATEGORIES.join(", ")})`,
        );
      const ok: readonly string[] =
        c === "agent_powers" ? ["ask", "never"] : SETTING_CHOICES;
      if (typeof v !== "string" || !ok.includes(v))
        throw new Error(
          `${key}.settings.${c}: ${ok.join(", ")}, not ${JSON.stringify(v) ?? "nothing"}`,
        );
      out.settings[c as SettingCategory] = v as SettingChoice;
    }
  }
  if (r.critical !== undefined && r.critical !== null)
    out.critical = listOf(
      r.critical,
      `${key}.critical`,
      WRITE_KIND_RE,
      "a kind of write (repo_clone, service_try, …)",
    );
  return out;
}

/**
 * Issue 160: what a held write is on, as watched items (`<kind>:<name>`):
 * its project, and the repo, service, persona or agent its args name.
 */
export function writeTargets(
  action: string,
  args: Record<string, unknown>,
  project: string | undefined,
): string[] {
  const s = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const out = new Set<string>();
  const add = (kind: string, v: string | undefined) => {
    if (v) out.add(`${kind}:${v}`);
  };
  add("project", project);
  add("project", s(args.project));
  add("project", s(args.workspace));
  if (action === "workspace_create") add("project", s(args.name));
  const service = s(args.service);
  if (service) {
    add("service", service);
    add("repo", service.split("/")[0]);
  }
  const base = (p: string | undefined) =>
    p
      ?.replace(/[/\\]+$/, "")
      .split(/[/\\:]/)
      .pop()
      ?.replace(/\.git$/, "");
  add("repo", base(s(args.path)));
  add("repo", base(s(args.source)));
  // A GitHub repo (owner/name, pr_close's) is watched by either name.
  const repo = s(args.repo);
  add("repo", repo);
  if (repo?.includes("/")) add("repo", base(repo));
  if (action.startsWith("persona_")) add("persona", s(args.id));
  add("persona", s(args.persona));
  add("agent", s(args.agent));
  return [...out];
}

/**
 * Issue 160: the first target a watch list names (`kind:name`, or a bare
 * name matching any kind), or undefined.
 */
export function watchedTarget(
  targets: readonly string[],
  watch: readonly string[],
): string | undefined {
  for (const t of targets) {
    const name = t.slice(t.indexOf(":") + 1);
    if (watch.some((w) => w === t || (!w.includes(":") && w === name)))
      return t;
  }
  return undefined;
}

/** Issue 160: rail pins (shell.pins: repo or repo/service) as watched items. */
export function pinsAsWatched(pins: readonly string[]): string[] {
  return pins.map((p) => (p.includes("/") ? `service:${p}` : `repo:${p}`));
}

const STRICT: Record<PolicyKind, number> = { auto: 0, notify: 1, ask: 2 };
const stricter = (a: PolicyKind, b: PolicyKind): PolicyKind =>
  STRICT[a] >= STRICT[b] ? a : b;

/**
 * The kind a held write follows, with where it came from. Ask, always:
 * critical (no setting lowers it), a critical list naming it (the
 * project's, the install's), or on something watched or pinned. Else the
 * project's own setting for this write, its policy, the install's for
 * this write, its policy, the write's own kind (HELD_WRITE_RISK `kind`),
 * the default. A write's own kind is stricter than a looser `policy`
 * (only a `writes` setting naming it lowers it), and gives way to a
 * stricter one.
 */
export function policyFor(
  action: string,
  o: {
    widens?: boolean;
    areas?: readonly CriticalArea[];
    install?: PolicySetting;
    project?: PolicySetting;
    /** What the write is on (writeTargets). */
    targets?: readonly string[];
    /** The person's rail pins (their favorites), as watched items. */
    pins?: readonly string[];
    /** Issue 1391: the install's mode; strict when not given. */
    mode?: InstallMode;
    /** Issue 1371 Part 2: a setting write's category (its check says). */
    setting?: { category: SettingCategory };
  },
): { kind: PolicyKind; from: string } {
  const mode = o.mode ?? "strict";
  const why = criticalWhy(action, o.widens === true, o.areas, mode);
  if (why) return { kind: "ask", from: why };
  if (o.project?.critical?.includes(action))
    return { kind: "ask", from: "project approvals.critical" };
  if (o.install?.critical?.includes(action))
    return { kind: "ask", from: "approvals.critical" };
  const targets = o.targets ?? [];
  const watched = watchedTarget(targets, [
    ...(o.project?.watch ?? []),
    ...(o.install?.watch ?? []),
  ]);
  if (watched) return { kind: "ask", from: `watched ${watched}` };
  const pinned = watchedTarget(targets, o.pins ?? []);
  if (pinned) return { kind: "ask", from: `favorited ${pinned}` };
  // Issue 1371 Part 2: a setting follows the person's choice for its
  // category (one setting for the install), else the mode's default.
  // Any held write whose check names a category (setting_change, issue
  // 1395's gate_settings_set) follows it.
  if (o.setting) {
    const c = settingChoice(o.setting.category, mode, o.install?.settings);
    return c.choice === "auto"
      ? { kind: "notify", from: c.from }
      : { kind: "ask", from: c.from };
  }
  const own = (s: PolicySetting | undefined) =>
    s?.writes && Object.hasOwn(s.writes, action) ? s.writes[action] : undefined;
  const entry = Object.hasOwn(HELD_WRITE_RISK, action)
    ? HELD_WRITE_RISK[action]
    : undefined;
  // Issue 1391: on a personal install a routine write's own ask gives way
  // to the policy, as the rest of it does.
  const placed =
    mode === "personal" && entry?.personal !== "keep" ? undefined : entry?.kind;
  const withOwn = (k: PolicyKind, from: string) =>
    placed && stricter(placed, k) !== k
      ? { kind: placed, from: `${action}'s own kind` }
      : { kind: k, from };
  const p = own(o.project);
  if (p) return { kind: p, from: `project approvals.writes.${action}` };
  if (o.project?.policy)
    return withOwn(o.project.policy, "project approvals.policy");
  const i = own(o.install);
  if (i) return { kind: i, from: `approvals.writes.${action}` };
  if (o.install?.policy) return withOwn(o.install.policy, "approvals.policy");
  if (placed) return { kind: placed, from: `${action}'s own kind` };
  return { kind: DEFAULT_POLICY, from: "default" };
}

/**
 * Issue 160: Settings' rows for the policy (the install's in /api/settings,
 * a project's in /api/workspaces/settings): `policy` (null clears it),
 * `watch` and `critical` (a list, or text split at commas and new lines;
 * null or empty clears it). The setting as stored after, undefined when
 * nothing is left; a bad value is an error naming the key.
 */
export function patchApprovals(
  current: unknown,
  patch: {
    policy?: unknown;
    watch?: unknown;
    critical?: unknown;
    /** Issue 1371 Part 2: { <category>: auto | ask | never | null }. */
    settings?: unknown;
  },
  key = "approvals",
):
  | { ok: true; value: PolicySetting | undefined }
  | { ok: false; error: string } {
  try {
    const cur: PolicySetting = { ...(readPolicySetting(current, key) ?? {}) };
    if (patch.policy !== undefined) {
      if (patch.policy === null || patch.policy === "") delete cur.policy;
      else cur.policy = kindOf(patch.policy, `${key}_policy`);
    }
    const list = (v: unknown): unknown =>
      typeof v === "string"
        ? v
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean)
        : v;
    for (const k of ["watch", "critical"] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      const l = v === null ? [] : list(v);
      const checked = readPolicySetting({ [k]: l }, key)?.[k] ?? [];
      if (checked.length) cur[k] = checked;
      else delete cur[k];
    }
    if (patch.settings !== undefined) {
      if (patch.settings === null) delete cur.settings;
      else {
        if (typeof patch.settings !== "object" || Array.isArray(patch.settings))
          throw new Error(`${key}_settings: a mapping of category to choice`);
        const next: Record<string, unknown> = { ...(cur.settings ?? {}) };
        for (const [c, v] of Object.entries(
          patch.settings as Record<string, unknown>,
        ))
          if (v === null) delete next[c];
          else next[c] = v;
        const checked = readPolicySetting({ settings: next }, key)?.settings;
        if (checked && Object.keys(checked).length) cur.settings = checked;
        else delete cur.settings;
      }
    }
    return {
      ok: true,
      value: Object.keys(cur).length ? cur : undefined,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Issue 160: what Settings shows for one level's policy. */
export function approvalsView(
  raw: unknown,
  mode: InstallMode = "strict",
): {
  policy: PolicyKind | null;
  watch: string[];
  critical: string[];
  /** Issue 1371 Part 2: each category's choice in force, and whether set. */
  settings: Record<SettingCategory, { choice: SettingChoice; set: boolean }>;
} {
  let s: PolicySetting | undefined;
  try {
    s = readPolicySetting(raw);
  } catch {
    s = undefined;
  }
  return {
    policy: s?.policy ?? null,
    watch: s?.watch ?? [],
    critical: s?.critical ?? [],
    settings: Object.fromEntries(
      SETTING_CATEGORIES.map((c) => [
        c,
        {
          choice: settingChoice(c, mode, s?.settings).choice,
          set: !!s?.settings && Object.hasOwn(s.settings, c),
        },
      ]),
    ) as Record<SettingCategory, { choice: SettingChoice; set: boolean }>,
  };
}
