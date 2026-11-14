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
 *
 * Its model: `agents.server_model` when the runtime offers it, else Sonnet
 * when the runtime offers Sonnet (DEFAULT_SERVER_MODEL), else the
 * runtime's own default. Only the runtime's own models are offered.
 */
import {
  AgentError,
  listAgents,
  listRuntimes,
  relaunchAgent,
  removeAgent,
  resumeAgent,
  resumeRefusal,
  startAgent,
  stopAgent,
  type AgentRow,
  type AgentsResolved,
  type RuntimeChoice,
  type Started,
  rotationOf,
} from "./agent-ops.js";
import { readRecord } from "../../shared/agents/records.js";
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
import { getDistRoot } from "../../shared/paths.js";
import * as os from "os";
import * as path from "path";

export interface ServerAgentDeps {
  /** user.yml's `agents.server_runtime` (the person's choice), if set. */
  readSetting?: () => string | undefined;
  /** Save (or, with null, clear) that choice. */
  saveSetting?: (id: string | null) => void;
  /** user.yml's `agents.server_model`, if set. */
  readModel?: () => string | undefined;
  /** Save (or, with null, clear) it. */
  saveModel?: (id: string | null) => void;
  /** A fresh Den: no repo in any workspace yet. */
  fresh?: () => boolean | Promise<boolean>;
  /** The product's name for people ("Acme"). */
  title?: () => string;
  /** This Den's folder (its distribution root). */
  root?: () => string;
}

interface Resolved {
  readSetting: () => string | undefined;
  saveSetting: (id: string | null) => void;
  readModel: () => string | undefined;
  saveModel: (id: string | null) => void;
  fresh: () => boolean | Promise<boolean>;
  title: () => string;
  root: () => string;
}

function resolve(s: ServerAgentDeps): Resolved {
  return {
    readSetting: s.readSetting ?? readServerRuntimeSetting,
    saveSetting: s.saveSetting ?? saveServerRuntimeSetting,
    readModel: s.readModel ?? (() => readAgentsKey("server_model")),
    saveModel: s.saveModel ?? ((id) => saveAgentsKey("server_model", id)),
    fresh: s.fresh ?? freshDen,
    title: s.title ?? (() => product().title),
    root: s.root ?? getDistRoot,
  };
}

/** A string key of user.yml's `agents`, if set. */
function readAgentsKey(
  key: "server_runtime" | "server_model",
): string | undefined {
  const v = (readUserConfig().agents as Record<string, unknown> | undefined)?.[
    key
  ];
  return typeof v === "string" && v ? v : undefined;
}

function saveAgentsKey(
  key: "server_runtime" | "server_model",
  id: string | null,
): void {
  const agents = { ...(readUserConfig().agents ?? {}) } as Record<
    string,
    unknown
  >;
  if (id === null) delete agents[key];
  else agents[key] = id;
  mergeUserConfig({
    agents: Object.keys(agents).length
      ? (agents as UserConfig["agents"])
      : undefined,
  });
}

/** user.yml's `agents.server_runtime`. */
export function readServerRuntimeSetting(): string | undefined {
  return readAgentsKey("server_runtime");
}

function saveServerRuntimeSetting(id: string | null): void {
  saveAgentsKey("server_runtime", id);
}

/** The server agent's model when the person picked none and its runtime offers it. */
export const DEFAULT_SERVER_MODEL = "sonnet";

/** The model to run on: the saved one when the runtime offers it, else Sonnet if offered, else none. */
export function pickModel(
  models: readonly { id: string }[],
  saved: string | undefined,
): string | undefined {
  if (saved && models.some((m) => m.id === saved)) return saved;
  return models.some((m) => m.id === DEFAULT_SERVER_MODEL)
    ? DEFAULT_SERVER_MODEL
    : undefined;
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
  /** The runtime it is running on now (its record's), when it runs. */
  runningRuntime?: string;
  /** The model it runs (or would run) on, when its runtime names models. */
  model?: string;
  /** The runtime's own models, for the picker. */
  models: { id: string; label?: string }[];
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

/**
 * The manual path for this Den, which already exists: from its folder,
 * add a repo and start it, with the Den's own command (`./bin/<cli>`, as
 * the install skill runs it). `dir` is the Den's folder, shown `~/…`
 * inside `home`.
 */
/** A folder as the person reads it: `~/…` inside `home`. */
function shownDir(dir: string, home?: string): string {
  const rel = home ? path.relative(home, dir) : "";
  if (home && rel === "") return "~";
  return home && rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? `~/${rel}`
    : dir;
}

export function manualPath(cli: string, dir: string, home?: string): string[] {
  const shown = shownDir(dir, home);
  const cd = /^[A-Za-z0-9_./~+-]+$/.test(shown)
    ? shown
    : `'${shown.replace(/'/g, `'\\''`)}'`;
  return [`cd ${cd}`, `./bin/${cli} repo add <path>`, `./bin/${cli} up`];
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
  const models = (rt?.models ?? []).map((m) => ({
    id: m.id,
    ...(m.label ? { label: m.label } : {}),
  }));
  const model = pickModel(models, r.readModel());
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
    ...(row &&
    (row.state === "running" || row.state === "stopping") &&
    row.runtime
      ? { runningRuntime: row.runtime }
      : {}),
    ...(model ? { model } : {}),
    models,
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
    manual: manualPath(d.cli, r.root(), d.env.HOME ?? os.homedir()),
  };
}

/**
 * The first thing the server agent hears on a fresh Den: it greets and
 * asks where the repos are in its first turn, with the folder above the
 * Den's as the default (`reposDefault`), so the person can just say yes.
 */
export function onboardingPrompt(title: string, reposDefault?: string): string {
  const ask = reposDefault
    ? `"Let's set up ${title}. Where are your repos? I'll look in ${reposDefault} unless you name another folder."`
    : `"Let's set up ${title}. Where are your repos?"`;
  return (
    `Set up ${title} with me. Start with onboard_status, then say ` +
    `${ask} and wait for my answer.`
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
  const model =
    runtime === status.runtime?.id
      ? status.model
      : pickModel(getRuntime(runtime ?? "")?.models?.() ?? [], r.readModel());
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
  // The same runtime and model: continue its conversation. Another model
  // picked since: a fresh start on it.
  if (
    rec &&
    rec.workspace === SERVER_SCOPE &&
    rec.runtime === runtime &&
    rec.model === model
  ) {
    if (rotationOf(d, rec)?.ready)
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
      ...(model ? { model } : {}),
      name: serverAgentName(title),
    },
    status.fresh
      ? {
          firstPrompt: onboardingPrompt(
            title,
            shownDir(path.dirname(r.root()), d.env.HOME ?? os.homedir()),
          ),
        }
      : {},
  );
  return done("started", st);
}

/**
 * 0.4.46 Start fresh: stop the server agent (if running), remove it, and
 * start a new one, a new conversation. What a person did before with
 * `agents stop server -w den-server` and `agents rm server -w den-server`.
 */
export async function freshServerAgent(
  d: AgentsResolved,
  s: ServerAgentDeps = {},
): Promise<ServerAgentStarted> {
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  if (rec && rec.workspace === SERVER_SCOPE) {
    const status = await serverAgentStatus(d, s);
    if (status.state === "running" || status.state === "stopping") {
      const st = await stopAgent(d, SERVER_AGENT_ID, SERVER_SCOPE, {
        wait: true,
      });
      if (st.stillStopping)
        throw new AgentError(
          `${serverAgentName(resolve(s).title())} is still stopping; try Start fresh again in a moment`,
          { status: 409 },
        );
    }
    await removeAgent(d, SERVER_AGENT_ID, SERVER_SCOPE);
  }
  return startServerAgent(d, {}, s);
}

/** Save the person's model choice; null clears it. Only the runtime's own. */
export async function setServerModel(
  d: AgentsResolved,
  id: string | null,
  s: ServerAgentDeps = {},
): Promise<void> {
  if (id !== null) {
    const st = await serverAgentStatus(d, s);
    if (!st.models.some((m) => m.id === id))
      throw new AgentError(
        `${st.runtime?.label ?? st.runtime?.id ?? "this runtime"} has no model "${id}"`,
        { usage: true },
      );
  }
  resolve(s).saveModel(id);
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
