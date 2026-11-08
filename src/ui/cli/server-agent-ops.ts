/**
 * The server agent's operations (ON-6), on top of the agent ones: what it
 * is and whether it runs (status), and starting it (start). It is a normal
 * Den agent in the reserved server scope (shared/agents/server-agent.ts),
 * id `server`, persona `server`, named "<Product> agent".
 *
 * Its runtime: `agents.server_runtime` in user.yml when that one is
 * installed, else the first installed catalog runtime that carries Den's
 * tools. Den can tell a runtime is installed, not that it is logged in: a
 * runtime that isn't asks the person to log in in its own terminal.
 */
import {
  AgentError,
  listAgents,
  listRuntimes,
  relaunchAgent,
  resumeAgent,
  resumeRefusal,
  startAgent,
  type AgentRow,
  type AgentsResolved,
  type RuntimeChoice,
  type Started,
} from "./agent-ops.js";
import { readRecord } from "../../shared/agents/records.js";
import { rotationInfo } from "../../shared/agents/rotation.js";
import {
  SERVER_AGENT_ID,
  SERVER_PERSONA_ID,
  SERVER_SCOPE,
  serverAgentName,
} from "../../shared/agents/server-agent.js";
import { getRuntime } from "../../shared/agents/runtime.js";
import {
  mergeUserConfig,
  readUserConfig,
  type UserConfig,
} from "../../shared/den-config.js";
import { product } from "../../shared/product.js";

export interface ServerAgentDeps {
  /** user.yml's `agents.server_runtime` (the person's choice), if set. */
  readSetting?: () => string | undefined;
  /** Save (or, with null, clear) that choice. */
  saveSetting?: (id: string | null) => void;
  /** A fresh Den: no repo in any workspace yet. */
  fresh?: () => boolean | Promise<boolean>;
  /** The product's name for people ("Acme"). */
  title?: () => string;
}

interface Resolved {
  readSetting: () => string | undefined;
  saveSetting: (id: string | null) => void;
  fresh: () => boolean | Promise<boolean>;
  title: () => string;
}

function resolve(s: ServerAgentDeps): Resolved {
  return {
    readSetting: s.readSetting ?? readServerRuntimeSetting,
    saveSetting: s.saveSetting ?? saveServerRuntimeSetting,
    fresh: s.fresh ?? freshDen,
    title: s.title ?? (() => product().title),
  };
}

/** user.yml's `agents.server_runtime`. */
export function readServerRuntimeSetting(): string | undefined {
  const v = (readUserConfig().agents as { server_runtime?: unknown })
    ?.server_runtime;
  return typeof v === "string" && v ? v : undefined;
}

function saveServerRuntimeSetting(id: string | null): void {
  const agents = { ...(readUserConfig().agents ?? {}) } as Record<
    string,
    unknown
  >;
  if (id === null) delete agents.server_runtime;
  else agents.server_runtime = id;
  mergeUserConfig({
    agents: Object.keys(agents).length
      ? (agents as UserConfig["agents"])
      : undefined,
  });
}

/** No repo in any workspace yet (workspaces.yml), or no workspaces file. */
export async function freshDen(): Promise<boolean> {
  // Imported when asked, like loadAgentWorkspaces: the CLI starts light.
  const ws = await import("../../shared/environment-manager/workspaces.js");
  let file: ReturnType<typeof ws.readWorkspacesFile>;
  try {
    file = ws.readWorkspacesFile();
  } catch {
    return true;
  }
  return Object.values(file.workspaces ?? {}).every(
    (w) => Object.keys(w?.services ?? {}).length === 0,
  );
}

/** A runtime the server agent can run on: installed, with Den's tools. */
function usable(r: RuntimeChoice): boolean {
  return r.available && r.denTools === true;
}

/** How to install a catalog runtime, when its catalog says (npm). */
function installHint(id: string): string | undefined {
  const pkg = getRuntime(id)?.catalog?.version?.identity?.package;
  return pkg ? `npm i -g ${pkg}` : undefined;
}

export interface ServerAgentStatus {
  /** "<Product> agent". */
  name: string;
  id: string;
  /** The reserved scope it lives in (never a workspace). */
  scope: string;
  persona: string;
  /** No repo in any workspace yet: the first page is this agent. */
  fresh: boolean;
  /** The person's choice (user.yml agents.server_runtime), if any. */
  setting?: string;
  /** The runtime it runs (or would run) on, or null when none can. */
  runtime: { id: string; label?: string } | null;
  /** Every catalog runtime, and whether the server agent can use it. */
  runtimes: {
    id: string;
    label?: string;
    available: boolean;
    denTools: boolean;
    usable: boolean;
    install?: string;
  }[];
  /** none (never started), running, stopping, stopped, exited, interrupted. */
  state: string;
  /** Its session, when it has one to open. */
  sessionId?: string;
  /** The way without any agent (Humans can do everything agents can). */
  manual: string[];
}

/** The manual path: install, create, add a repo, start it. */
export function manualPath(cli: string): string[] {
  return [
    "npm i -g @monster-orange/den",
    "den create <name>",
    `${cli} repo add <path>`,
    `${cli} up`,
  ];
}

/** The runtime to run on: the person's choice when usable, else the first. */
export function pickRuntime(
  rows: RuntimeChoice[],
  setting: string | undefined,
): RuntimeChoice | null {
  const chosen = setting ? rows.find((r) => r.id === setting) : undefined;
  if (chosen && usable(chosen)) return chosen;
  return rows.find(usable) ?? null;
}

export async function serverAgentStatus(
  d: AgentsResolved,
  s: ServerAgentDeps = {},
): Promise<ServerAgentStatus> {
  const r = resolve(s);
  const rows = (await listRuntimes(d)).filter((x) => x.denTools !== undefined);
  const setting = r.readSetting();
  const rt = pickRuntime(rows, setting);
  let row: AgentRow | undefined;
  try {
    row = (await listAgents(d, SERVER_SCOPE, { startHost: false })).find(
      (x) => x.agent === SERVER_AGENT_ID,
    );
  } catch {
    row = undefined;
  }
  return {
    name: serverAgentName(r.title()),
    id: SERVER_AGENT_ID,
    scope: SERVER_SCOPE,
    persona: SERVER_PERSONA_ID,
    fresh: await r.fresh(),
    ...(setting ? { setting } : {}),
    runtime: rt
      ? { id: rt.id, ...(rt.label ? { label: rt.label } : {}) }
      : null,
    runtimes: rows.map((x) => {
      const install = x.available ? undefined : installHint(x.id);
      return {
        id: x.id,
        ...(x.label ? { label: x.label } : {}),
        available: x.available,
        denTools: x.denTools === true,
        usable: usable(x),
        ...(install ? { install } : {}),
      };
    }),
    state: row?.state ?? "none",
    ...(row?.session ? { sessionId: row.session.ref.id } : {}),
    manual: manualPath(d.cli),
  };
}

/** The first thing the server agent hears on a fresh Den. */
export function onboardingPrompt(title: string): string {
  return (
    `Set up ${title} with me. Start with onboard_status, then say ` +
    `"Let's set up ${title}. Where are your repos?" and wait for my answer.`
  );
}

export interface ServerAgentStarted {
  /** started, resumed, relaunched, or running (it already was). */
  how: "started" | "resumed" | "relaunched" | "running";
  sessionId: string;
  runtime: string;
  warnings: string[];
}

/**
 * Start the server agent, or bring it back: running, it is left as it is;
 * stopped with a conversation to continue, it resumes (AG-14); rotated, it
 * relaunches from its handoff; else it starts fresh, and on a fresh Den
 * with the onboarding prompt.
 */
export async function startServerAgent(
  d: AgentsResolved,
  req: { runtime?: string } = {},
  s: ServerAgentDeps = {},
): Promise<ServerAgentStarted> {
  const r = resolve(s);
  const status = await serverAgentStatus(d, s);
  if (
    (status.state === "running" || status.state === "stopping") &&
    status.sessionId
  )
    return {
      how: "running",
      sessionId: status.sessionId,
      runtime: readRecord(d.stateDir(), SERVER_AGENT_ID)?.runtime ?? "",
      warnings: [],
    };
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  const runtime = req.runtime ?? status.runtime?.id;
  if (!runtime)
    throw new AgentError(
      "no runtime can run the server agent: install one from the runtime catalog",
      { status: 503, code: "no_runtime", hints: status.manual },
    );
  const done = (how: ServerAgentStarted["how"], st: Started) => ({
    how,
    sessionId: st.info.ref.id,
    runtime: st.rec.runtime,
    warnings: st.warnings,
  });
  if (rec && rec.workspace === SERVER_SCOPE && rec.runtime === runtime) {
    if (rotationInfo(d.stateDir(), rec)?.ready)
      return done("relaunched", await relaunchAgent(d, rec.id));
    if (resumeRefusal(rec) === null)
      return done("resumed", await resumeAgent(d, rec.id, SERVER_SCOPE));
  }
  const title = r.title();
  const st = await startAgent(
    d,
    {
      workspace: SERVER_SCOPE,
      persona: SERVER_PERSONA_ID,
      id: SERVER_AGENT_ID,
      runtime,
      name: serverAgentName(title),
    },
    status.fresh ? { firstPrompt: onboardingPrompt(title) } : {},
  );
  return done("started", st);
}

/** Save the person's runtime choice; null clears it. */
export function setServerRuntime(
  id: string | null,
  s: ServerAgentDeps = {},
): void {
  if (id !== null && !getRuntime(id))
    throw new AgentError(`no runtime "${id}"`, { usage: true });
  resolve(s).saveSetting(id);
}
