/**
 * The Agents tab's routes (AG-4a-term, AG spec §5d):
 *
 *   GET /api/sessions            every session and agent in the active
 *                                workspaces (read-only class)
 *   WS  /api/sessions/<id>/io    a session's terminal (shell-grade)
 *   POST /api/sessions/<id>/uploads?name=<file>
 *                                AG-DROP: a file dropped or pasted onto
 *                                its terminal (shell-grade, the same
 *                                principal and checks as the io route).
 *                                The body is the file's bytes; the answer
 *                                is { ok, path }, the absolute path the
 *                                page types at the cursor. Past
 *                                agents.uploads.max_bytes: 413, naming it.
 *
 * The list joins the session host's sessions to the agent records, as
 * `<cli> agents list` does (agent-ops.ts agentRows), and adds the plain
 * sessions (`sessions start`), labelled kind "session". An agent whose
 * actor token `web logout --all` revoked is marked (tokenRevoked). The
 * agent with one of Den's held writes waiting for the person (ON-3,
 * approval-routes.ts) is `waiting` (AG-6a); a runtime's own permission
 * prompts are not seen here yet. Asking never starts a session host.
 *
 * The io route bridges one WebSocket to one attachment on the session host
 * (its own connection to the host, so a browser and the CLI, or two
 * browsers, attach at once and each gets every byte):
 *   - on attach, the scrollback replay, then live output: binary frames;
 *   - a text frame `{"type":"session",…}` first (what is attached), and
 *     `{"type":"exit","exitCode":n}` when the session ends;
 *   - `{"type":"size","cols":c,"rows":r}`: the PTY's size, on attach and
 *     each time any viewer (another browser, a CLI attach) resizes it. The
 *     size is last-writer-wins; a pane that learns it is out of step says
 *     its own again when it is used (focused, typed in, shown);
 *   - in: binary frames are input; a text frame is JSON control:
 *     `{"type":"resize","cols":c,"rows":r}` (or `{"type":"input","data":s}`).
 * Closing the socket detaches. Nothing here ever signals a session: leaving
 * the tab never kills it.
 *
 * The request checks ran before (index.ts, request-guard.ts): Host, Origin
 * on the upgrade, CSRF (the `den.csrf.<token>` subprotocol: a browser's
 * WebSocket can't send a header), a signed-in session beyond loopback, and
 * an agent token's own session only. The attach and the detach are audited
 * with the actor from the credential.
 */
import { apiOnlyNames } from "../../shared/agents/api-only.js";
import * as fs from "fs";
import type * as http from "http";
import * as path from "path";
import {
  pruneUploads,
  uploadPath,
  uploadsRoot,
  UPLOAD_DEFAULTS,
  type UploadSettings,
} from "../../shared/agents/uploads.js";
import {
  SERVER_SCOPE,
  isServerScope,
} from "../../shared/agents/server-agent.js";
import type { Duplex } from "stream";
import {
  getActiveWorkspaces,
  readWorkspacesFile,
} from "../../shared/environment-manager/workspaces.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { revokedAgentIds } from "../../shared/actor-token.js";
import { agentFilesDir, listRecords } from "../../shared/agents/records.js";
import { readClearedAt } from "../../shared/agents/helpers-cleared.js";
import { softNewlineSeq } from "../../shared/agents/catalog.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import type {
  RotationEntry,
  RotationInfo,
  RotationPolicy,
} from "../../shared/agents/rotation.js";
import {
  connectHost,
  noHost,
  type HostClient,
} from "../../shared/sessions/client.js";
import { parseSessionName } from "../../shared/sessions/names.js";
import { sessionPaths } from "../../shared/sessions/paths.js";
import { loadPty, type PtyLoad } from "../../shared/sessions/pty.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import type { HelperSettings } from "../../shared/agents/helpers.js";
import { readAgentsConfig } from "../../shared/den-config.js";
import {
  agentRows,
  defaultHubNow,
  isStoppedState,
  mcpStaleOf,
  newerOf,
  noteEnded,
  rowHelpers,
  type AgentRow,
} from "../cli/agent-ops.js";
import type { AgentRecord, Override } from "../../shared/agents/records.js";
import { state as sessionState } from "../cli/sessions-command.js";
import { recordAction } from "./audit.js";
import { sendJson } from "./http-helpers.js";
import { auditActorOf, principalOf } from "./request-guard.js";
import {
  acceptWebSocket,
  handshakeRefusal,
  refuseUpgrade,
  WS_CLOSE,
} from "./websocket.js";

export interface SessionRouteDeps {
  stateDir?: () => string;
  /** The distribution's name: the `<dist>` of a session name. */
  dist?: () => string;
  /** A client of the running host, or null (never starts one). */
  connectExisting?: () => Promise<HostClient | null>;
  activeWorkspaces?: () => string[];
  /** Whether workspaces.yml names `ws` (active or not). */
  workspaceExists?: (ws: string) => boolean;
  pty?: () => PtyLoad;
  /** The agent ids with an approval waiting for the person (AG-6a, ON-3). */
  waitingAgents?: () => ReadonlySet<string>;
  /** D28: each agent's effective rotation settings (one resolver per list). */
  rotationPolicy?: () => (rec: AgentRecord) => RotationPolicy | undefined;
  /** D59: whether each agent resumes on its own after a restart. */
  restartResume?: () => (rec: AgentRecord) => boolean;
  /** D32: agents.helpers (default: the agents config's, else its defaults). */
  helperSettings?: () => HelperSettings | undefined;
  /** D44: the Hub server URL an agent would get now (null: none). */
  hubNow?: () => Promise<string | null>;
  /** AG-DROP: agents.uploads (default: the agents config's). */
  uploadSettings?: () => UploadSettings;
  now?: () => Date;
}

interface Resolved {
  stateDir: () => string;
  dist: () => string;
  connectExisting: () => Promise<HostClient | null>;
  activeWorkspaces: () => string[];
  workspaceExists: (ws: string) => boolean;
  pty: () => PtyLoad;
  waitingAgents: () => ReadonlySet<string>;
  rotationPolicy?: SessionRouteDeps["rotationPolicy"];
  restartResume?: SessionRouteDeps["restartResume"];
  helperSettings: () => HelperSettings | undefined;
  hubNow: () => Promise<string | null>;
  uploadSettings: () => UploadSettings;
  now: () => Date;
}

/** A workspace name as `?ws=` may give it. */
const WS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function resolve(d: SessionRouteDeps = {}): Resolved {
  const stateDir = d.stateDir ?? (() => getStateDir());
  return {
    stateDir,
    dist: d.dist ?? (() => product().name),
    connectExisting:
      d.connectExisting ??
      (async () => {
        try {
          return await connectHost(sessionPaths(stateDir()).socket);
        } catch (e) {
          if (noHost(e)) return null;
          throw e;
        }
      }),
    helperSettings:
      d.helperSettings ??
      (() => {
        try {
          return readAgentsConfig().helpers;
        } catch {
          return undefined;
        }
      }),
    activeWorkspaces: d.activeWorkspaces ?? (() => getActiveWorkspaces()),
    workspaceExists:
      d.workspaceExists ??
      ((ws) =>
        Object.prototype.hasOwnProperty.call(
          readWorkspacesFile().workspaces ?? {},
          ws,
        )),
    pty: d.pty ?? (() => loadPty()),
    waitingAgents: d.waitingAgents ?? (() => new Set<string>()),
    hubNow: d.hubNow ?? (() => defaultHubNow()),
    uploadSettings:
      d.uploadSettings ??
      (() => readAgentsConfig().uploads ?? { ...UPLOAD_DEFAULTS }),
    now: d.now ?? (() => new Date()),
    ...(d.rotationPolicy ? { rotationPolicy: d.rotationPolicy } : {}),
    ...(d.restartResume ? { restartResume: d.restartResume } : {}),
  };
}

/** The subprotocol the io route answers with. */
export const IO_PROTOCOL = "den.io";

const IO_PATH = /^\/api\/sessions\/([^/]+)\/io$/;
const UPLOAD_PATH = /^\/api\/sessions\/([^/]+)\/uploads$/;
/**
 * D54: the browsers viewing each session now (by session id). Each hears
 * how many there are when that changes: one left alone sizes the PTY.
 */
const VIEWERS = new Map<
  string,
  Set<{ open: boolean; send(d: string): void }>
>();

function tellViewers(id: string): void {
  const set = VIEWERS.get(id);
  if (!set) return;
  const frame = JSON.stringify({ type: "viewers", n: set.size });
  for (const v of set) if (v.open) v.send(frame);
}

/** One row of the Agents tab's list. */
export interface ListedSession {
  /** The session host's id; for an agent with no session, its last one. */
  id: string;
  /** `<dist>-<ws>:<name>`. */
  name: string;
  workspace: string;
  /** ON-6: the server agent's row (its workspace is the server scope). */
  server?: boolean;
  kind: "agent" | "session";
  /** D20: the launchd session its host runs in (Aqua ends at logout). */
  launchd?: string;
  /** The `<name>` part: an agent's id, a plain session's name. */
  label: string;
  agent?: string;
  /** The name a person gave the agent (AG-4b), when one did. */
  displayName?: string;
  /**
   * The name its session shows (AG-4b): the latest of Den's rename and the
   * runtime's (Claude Code's /rename), when there is one. Its handle is
   * `name`.
   */
  sessionTitle?: string;
  /**
   * What Shift+Enter sends to it (AG-4b, its catalog entry's softNewline):
   * ESC CR unless the runtime says otherwise. A plain session: Enter (CR).
   */
  softNewline?: string;
  persona?: string;
  runtime?: string;
  model?: string;
  /** den#3: its subagents' model ("inherit": the runtime decides). */
  subagentModel?: string;
  subagentModelFrom?: "persona" | "org" | "default";
  /** A pinned model version (AG-12), and the newer one when there is. */
  version?: string;
  newer?: string;
  /** Its permission intent (AG-13): ask, edits, all. */
  permission?: string;
  /** Extra allowed commands it was started with (AG-13.3). */
  allow?: string[];
  /** What it overrides of its persona (AG-10.9): its row's tags. */
  overrides?: Override[];
  /** D59: its own Resume after a restart (unset: its persona's). */
  resumeOnRestart?: boolean;
  /** D59: whether it resumes on its own after a restart, all told. */
  resumesOnRestart?: boolean;
  cwd?: string;
  /** running, stopping, exited (<code>), stopped, interrupted (AG-14). */
  state: string;
  exited: boolean;
  exitCode?: number;
  startedAt?: string;
  /** The host has it (running, or ended with its scrollback): a pane can attach. */
  attachable: boolean;
  resumable?: boolean;
  /** AG-18: Change persona… applies (its runtime can resume). */
  personaChange?: boolean;
  /** Why only Start fresh applies (AG-14.2): "<runtime> can't resume a conversation". */
  noResume?: string;
  /** When it was stopped, seen to end, or found interrupted (AG-14.1). */
  stoppedAt?: string;
  endedAt?: string;
  interruptedAt?: string;
  /** Its actor token was revoked (`web logout --all`): restart or resume it. */
  tokenRevoked?: boolean;
  /** An approval is pending (AG-6a; only when the host knows). */
  waiting?: boolean;
  /**
   * Session rotation (den#4): why it rotates and its handoff.md. `ready`:
   * Relaunch from handoff is its action, not Resume.
   */
  rotation?: RotationInfo;
  /** D28: the last relaunch from a handoff (the page toasts one Den did by itself). */
  lastRotation?: RotationEntry;
  /** D32: its helpers (counts and the recent ones). */
  helpers?: AgentRow["helpers"];
  /** D44: running with MCP servers out of date (Hub since it launched). */
  mcpStale?: AgentRow["mcpStale"];
}

/** The list, from the host's sessions and the agent records. */
export function listedSessions(
  sessions: SessionInfo[],
  d: Pick<Resolved, "stateDir" | "dist" | "activeWorkspaces"> &
    Partial<Pick<Resolved, "waitingAgents">> &
    Partial<Pick<Resolved, "helperSettings">> &
    Pick<SessionRouteDeps, "rotationPolicy" | "restartResume">,
  /** A workspace asked for by name (`?ws=`), listed even when inactive. */
  also?: string,
  /** D44: the Hub server URL agents get now; undefined: not checked. */
  hubUrl?: string | null,
): ListedSession[] {
  const dist = d.dist();
  const active = new Set(d.activeWorkspaces());
  if (also) active.add(also);
  // ON-6: the server agent belongs to no workspace, and is always listed.
  active.add(SERVER_SCOPE);
  const mine = sessions.filter((s) => {
    const p = parseSessionName(s.name, dist);
    return p !== null && active.has(p.workspace);
  });
  const records = listRecords(d.stateDir()).filter((r) =>
    active.has(r.workspace),
  );
  const revoked = revokedAgentIds(d.stateDir());
  const waiting = d.waitingAgents?.() ?? new Set<string>();
  const out: ListedSession[] = [];
  const agentSessions = new Set<string>();
  noteEnded(d.stateDir(), mine, records);
  const helperSettings = d.helperSettings?.();
  const restartOf = d.restartResume?.();
  for (const r of agentRows(
    mine,
    records,
    d.stateDir(),
    d.rotationPolicy?.(),
  )) {
    const rec = records.find((x) => x.id === r.agent)!;
    const s = r.session;
    if (s) agentSessions.add(s.ref.id);
    out.push({
      id: s?.ref.id ?? rec.session.id,
      name: s?.name ?? rec.sessionName,
      workspace: rec.workspace,
      ...(isServerScope(rec.workspace) ? { server: true } : {}),
      kind: "agent",
      label: rec.id,
      agent: rec.id,
      ...(rec.displayName ? { displayName: rec.displayName } : {}),
      ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
      softNewline: softNewlineSeq(getRuntime(rec.runtime)?.catalog),
      persona: rec.persona,
      runtime: rec.runtime,
      ...(rec.model ? { model: rec.model } : {}),
      // den#3: its subagents' model and where it came from.
      ...(r.subagentModel
        ? {
            subagentModel: r.subagentModel,
            subagentModelFrom: r.subagentModelFrom,
          }
        : {}),
      ...(rec.version ? { version: rec.version } : {}),
      ...newerOf(rec),
      ...(rec.permission ? { permission: rec.permission } : {}),
      ...(rec.allow?.length ? { allow: [...rec.allow] } : {}),
      ...(rec.overrides?.length ? { overrides: [...rec.overrides] } : {}),
      // D59: its own Resume after a restart, and the setting all told.
      ...(rec.resumeOnRestart !== undefined
        ? { resumeOnRestart: rec.resumeOnRestart }
        : {}),
      ...(restartOf ? { resumesOnRestart: restartOf(rec) } : {}),
      cwd: rec.cwd,
      state: r.state,
      exited: !s || s.exited === true,
      ...(s?.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s?.launchd ? { launchd: s.launchd } : {}),
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
      attachable: Boolean(s),
      resumable: r.resumable,
      ...(r.personaChange ? { personaChange: true } : {}),
      ...(r.noResume ? { noResume: r.noResume } : {}),
      ...(r.stoppedAt ? { stoppedAt: r.stoppedAt } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.interruptedAt ? { interruptedAt: r.interruptedAt } : {}),
      // D28: always (its effective settings show), due or not.
      ...(r.rotation ? { rotation: r.rotation } : {}),
      ...(r.lastRotation ? { lastRotation: r.lastRotation } : {}),
      ...(revoked.has(rec.id) && s && !s.exited ? { tokenRevoked: true } : {}),
      ...(waiting.has(rec.id) && s && !s.exited ? { waiting: true } : {}),
      ...(() => {
        if (hubUrl === undefined || r.state !== "running") return {};
        const st = mcpStaleOf(agentFilesDir(d.stateDir(), rec.id), hubUrl);
        return st ? { mcpStale: st } : {};
      })(),
      // D32: the helpers it started in its own session.
      ...(() => {
        const h = rowHelpers(
          rec,
          !isStoppedState(r.state),
          helperSettings,
          process.env,
          Date.now(),
          readClearedAt(agentFilesDir(d.stateDir(), rec.id)),
        );
        return h ? { helpers: h } : {};
      })(),
    });
  }
  for (const s of mine) {
    if (agentSessions.has(s.ref.id)) continue;
    const p = parseSessionName(s.name, dist)!;
    out.push({
      id: s.ref.id,
      name: s.name,
      workspace: p.workspace,
      kind: "session",
      label: p.name,
      // D66: every row says what Shift+Enter sends; a plain session's is
      // Enter.
      softNewline: "\r",
      state: sessionState(s),
      exited: s.exited === true,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s.launchd ? { launchd: s.launchd } : {}),
      startedAt: s.startedAt,
      attachable: true,
    });
  }
  const order = [...active];
  return out.sort(
    (a, b) =>
      order.indexOf(a.workspace) - order.indexOf(b.workspace) ||
      (a.startedAt ?? "").localeCompare(b.startedAt ?? "") ||
      a.label.localeCompare(b.label),
  );
}

/** D32: the helpers count, under /api/sessions/ but no session's route. */
export const SESSION_HELPERS_PATH = "/api/sessions/helpers";

/**
 * `GET /api/sessions`; false when `pathname` isn't it. `ioAllowed` is what
 * the request checks say about this browser: beyond loopback without a
 * session, the page lists but can't open a terminal.
 */
export async function handleSessionList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  ioAllowed: boolean,
  deps: SessionRouteDeps = {},
): Promise<boolean> {
  if (pathname === "/api/sessions/helpers")
    return helpersRunning(req, res, deps);
  if (pathname !== "/api/sessions") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, { ok: false, error: "method not allowed" }, 405);
    return true;
  }
  const d = resolve(deps);
  const pty = d.pty();
  let sessions: SessionInfo[] = [];
  let host = false;
  let hostError: string | undefined;
  try {
    const c = await d.connectExisting();
    if (c) {
      host = true;
      try {
        sessions = await c.list();
      } finally {
        c.close();
      }
    }
  } catch (e) {
    hostError = (e as Error).message;
  }
  // `?ws=<name>`: that workspace's too, active or not, and whether it is
  // active and known (the page says so rather than show all of them).
  const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    "ws",
  );
  const wanted =
    asked && WS_NAME.test(asked)
      ? {
          workspace: asked,
          active: d.activeWorkspaces().includes(asked),
          known: d.workspaceExists(asked),
        }
      : null;
  sendJson(res, {
    sessions: listedSessions(
      sessions,
      d,
      wanted?.known ? wanted.workspace : undefined,
      sessions.length ? await d.hubNow().catch(() => undefined) : undefined,
    ),
    workspaces: d.activeWorkspaces(),
    ...(wanted ? { requested: wanted } : {}),
    host,
    ...(hostError ? { hostError } : {}),
    backend: pty.available
      ? { id: "den-pty", available: true }
      : { id: "den-pty", available: false, reason: pty.reason },
    io: { allowed: ioAllowed },
    // D47: the services agents reach only through their API (den-claude).
    apiOnly: apiOnlyNames(d.stateDir()),
  });
  return true;
}

/** Whether `pathname` is a session's io route. */
export function isSessionIoPath(pathname: string): boolean {
  return IO_PATH.test(pathname);
}

const TEXT = (code: number) =>
  code === 400
    ? "Bad Request"
    : code === 404
      ? "Not Found"
      : code === 426
        ? "Upgrade Required"
        : "Service Unavailable";

/**
 * Whether a session is one the io route serves: this distribution's, in a
 * workspace workspaces.yml names, active or not (0.4.17: an agent you can
 * start and see, you can open). The person's and the agent's checks are
 * the request guard's, before this.
 */
function servedSession(
  s: SessionInfo,
  target: string,
  d: Resolved,
  active: ReadonlySet<string>,
): boolean {
  const p = parseSessionName(s.name, d.dist());
  return (
    p !== null &&
    (active.has(p.workspace) ||
      isServerScope(p.workspace) ||
      d.workspaceExists(p.workspace)) &&
    (s.ref.id === target || s.name === target)
  );
}

/**
 * Why the io route would refuse `target`, or null when it would open it:
 * what a browser can't read from a refused upgrade (it sees only a close),
 * so the page asks this with a plain GET (0.4.17).
 */
async function ioRefusal(
  target: string,
  d: Resolved,
): Promise<{ status: number; error: string; code: string } | null> {
  let c: HostClient | null;
  try {
    c = await d.connectExisting();
  } catch (e) {
    return {
      status: 503,
      error: `the session host: ${(e as Error).message}`,
      code: "session_host",
    };
  }
  if (!c)
    return {
      status: 404,
      error: `no session "${target}" (no session host is running)`,
      code: "not_found",
    };
  try {
    const active = new Set(d.activeWorkspaces());
    const found = (await c.list()).some((s) =>
      servedSession(s, target, d, active),
    );
    return found
      ? null
      : {
          status: 404,
          error: `no session "${target}" here`,
          code: "not_found",
        };
  } catch (e) {
    return {
      status: 503,
      error: `the session host: ${(e as Error).message}`,
      code: "session_host",
    };
  } finally {
    c.close();
  }
}

/** The served session `target` names, or why there is none. */
async function servedTarget(
  target: string,
  d: Resolved,
): Promise<
  { s: SessionInfo } | { status: number; error: string; code: string }
> {
  let c: HostClient | null;
  try {
    c = await d.connectExisting();
  } catch (e) {
    return {
      status: 503,
      error: `the session host: ${(e as Error).message}`,
      code: "session_host",
    };
  }
  if (!c)
    return {
      status: 404,
      error: `no session "${target}" (no session host is running)`,
      code: "not_found",
    };
  try {
    const active = new Set(d.activeWorkspaces());
    const s = (await c.list()).find((x) => servedSession(x, target, d, active));
    return s
      ? { s }
      : {
          status: 404,
          error: `no session "${target}" here`,
          code: "not_found",
        };
  } catch (e) {
    return {
      status: 503,
      error: `the session host: ${(e as Error).message}`,
      code: "session_host",
    };
  } finally {
    c.close();
  }
}

/** When uploads were last pruned (once an hour at most). */
let lastPrune = 0;

const mb = (n: number) =>
  n >= 1024 * 1024
    ? `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.ceil(n / 1024)} KB`;

/**
 * AG-DROP: `POST /api/sessions/<id>/uploads?name=<file>`. The request
 * checks ran before (CSRF, sign-in, an agent's own session only). The body
 * streams to a 0600 file in a 0700 folder; past max_bytes it stops and
 * answers 413. Audited with the credential's actor.
 */
async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
  d: Resolved,
): Promise<void> {
  const nameAsked = (() => {
    try {
      return new URL(req.url ?? "/", "http://localhost").searchParams.get(
        "name",
      );
    } catch {
      return null;
    }
  })();
  let sessionName = target;
  let ws: string | undefined = undefined;
  // Every upload is audited, a refusal too (its reason the code sent).
  const audit = (detail: string, refused?: string) =>
    recordAction(
      auditActorOf(req),
      {
        verb: "upload",
        detail: detail.slice(0, 400),
        ...(refused ? { outcome: "refused" as const, reason: refused } : {}),
        ...(ws ? { targetWorkspace: ws } : {}),
      },
      principalOf(req),
    );
  const refuse = (
    status: number,
    error: string,
    code: string,
    audited = false,
  ) => {
    if (!audited) audit(`${sessionName}: ${nameAsked ?? "(no name)"}`, code);
    // A refusal before the body is read: the browser still sends it, so
    // drop it rather than leave the connection to time out.
    req.resume();
    sendJson(res, { ok: false, error, code }, status);
  };
  let set: UploadSettings;
  try {
    set = d.uploadSettings();
  } catch (e) {
    return refuse(500, (e as Error).message, "config");
  }
  const tooBig = (n?: number, audited = false) =>
    refuse(
      413,
      `${n ? `${mb(n)} is` : "That file is"} over agents.uploads.max_bytes (${mb(set.maxBytes)}). ` +
        `Raise it in ${product().configFile}, or send a smaller file.`,
      "too_large",
      audited,
    );
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > set.maxBytes) return tooBig(len);
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.searchParams.get("name") ?? "";
  if (!name.trim())
    return refuse(400, "name: the file's name is missing", "bad_request");
  const found = await servedTarget(target, d);
  if (!("s" in found)) return refuse(found.status, found.error, found.code);
  const s = found.s;
  sessionName = s.name;
  ws = parseSessionName(s.name, d.dist())?.workspace;
  if (s.exited)
    return refuse(
      409,
      `${s.name} has ended: nothing to attach a file to`,
      "exited",
    );
  const root = uploadsRoot(set, d.stateDir());
  const now = d.now();
  let file: string;
  try {
    file = uploadPath(root, s.ref.id, name, now);
  } catch (e) {
    return refuse(400, (e as Error).message, "bad_request");
  }
  const dir = path.dirname(file);
  const part = `${file}.part`;
  let fd: number;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A folder or link in the way is never written through.
    if (!fs.lstatSync(dir).isDirectory())
      throw new Error(`${dir} is not a folder`);
    fd = fs.openSync(
      part,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
  } catch (e) {
    return refuse(
      500,
      `couldn't write the file: ${(e as Error).message}`,
      "write_failed",
    );
  }
  let bytes = 0;
  let over = false;
  const ok = await new Promise<boolean>((done) => {
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > set.maxBytes) {
        over = true;
        req.pause();
        return done(false);
      }
      try {
        fs.writeSync(fd, chunk);
      } catch {
        done(false);
      }
    });
    req.on("end", () => done(!over));
    req.on("error", () => done(false));
    req.on("aborted", () => done(false));
  });
  try {
    fs.closeSync(fd);
  } catch {
    /* closed */
  }
  if (!ok) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* none */
    }
    audit(`${s.name}: ${path.basename(file)}`, over ? "too_large" : "aborted");
    if (over) {
      res.setHeader("Connection", "close");
      return tooBig(undefined, true);
    }
    if (!res.headersSent)
      sendJson(
        res,
        { ok: false, error: "the upload didn't finish", code: "aborted" },
        400,
      );
    return;
  }
  try {
    fs.renameSync(part, file);
  } catch (e) {
    return refuse(
      500,
      `couldn't write the file: ${(e as Error).message}`,
      "write_failed",
    );
  }
  audit(`${s.name}: ${path.basename(file)} (${bytes} bytes)`);
  if (now.getTime() - lastPrune > 60 * 60 * 1000) {
    lastPrune = now.getTime();
    try {
      pruneUploads(root, set.keepDays, now.getTime());
    } catch {
      /* next time */
    }
  }
  sendJson(res, { ok: true, path: file, bytes });
}

/**
 * A plain HTTP request to an io route: it is a WebSocket. For a GET, the
 * refusal its upgrade would get (404, 503), else 426; 404 for anything
 * else under /api/sessions/.
 */
export async function sendSessionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: SessionRouteDeps = {},
): Promise<void> {
  const up = UPLOAD_PATH.exec(pathname);
  if (up && req.method === "POST") {
    let target = up[1];
    try {
      target = decodeURIComponent(target);
    } catch {
      /* as given */
    }
    await handleUpload(req, res, target, resolve(deps));
    return;
  }
  const m = IO_PATH.exec(pathname);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    let target = m[1];
    try {
      target = decodeURIComponent(target);
    } catch {
      /* as given */
    }
    const why = await ioRefusal(target, resolve(deps));
    if (why) {
      sendJson(
        res,
        { ok: false, error: why.error, code: why.code },
        why.status,
      );
      return;
    }
    res.setHeader("Upgrade", "websocket");
    res.setHeader("Connection", "Upgrade");
    sendJson(
      res,
      {
        ok: false,
        error: "This is a WebSocket: open it with an upgrade",
        code: "upgrade_required",
      },
      426,
    );
    return;
  }
  sendJson(
    res,
    { ok: false, error: "No such session route", code: "not_found" },
    404,
  );
}

/**
 * `GET /api/sessions/<id>/io` with an upgrade, after the request checks.
 * `<id>` is the host's id or the full session name. Refusals answer as
 * HTTP on the raw socket; past them, the WebSocket bridge above.
 */
export async function handleSessionUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathname: string,
  requestId: string,
  deps: SessionRouteDeps = {},
): Promise<void> {
  const refuse = (status: number, error: string, code: string) =>
    refuseUpgrade(
      socket,
      status,
      { ok: false, error, code, requestId },
      TEXT(status),
    );
  const m = IO_PATH.exec(pathname);
  if (!m) return refuse(404, "No WebSocket route here", "not_found");
  const bad = handshakeRefusal(req);
  if (bad) return refuse(400, bad, "bad_handshake");
  let target = m[1];
  try {
    target = decodeURIComponent(target);
  } catch {
    /* as given */
  }
  const d = resolve(deps);
  let c: HostClient | null;
  try {
    c = await d.connectExisting();
  } catch (e) {
    return refuse(
      503,
      `the session host: ${(e as Error).message}`,
      "session_host",
    );
  }
  if (!c)
    return refuse(
      404,
      `no session "${target}" (no session host is running)`,
      "not_found",
    );
  const client = c;
  let info: SessionInfo | undefined;
  try {
    const active = new Set(d.activeWorkspaces());
    info = (await client.list()).find((s) =>
      servedSession(s, target, d, active),
    );
  } catch (e) {
    client.close();
    return refuse(
      503,
      `the session host: ${(e as Error).message}`,
      "session_host",
    );
  }
  if (!info) {
    client.close();
    return refuse(404, `no session "${target}" here`, "not_found");
  }
  if (socket.destroyed) {
    client.close();
    return;
  }

  const s = info;
  const actor = auditActorOf(req);
  const principal = principalOf(req);
  const audit = (detail: string) =>
    recordAction(actor, { verb: "sessions", detail }, principal);
  const ws = acceptWebSocket(req, socket, head, { protocol: IO_PROTOCOL });
  const since = Date.now();
  audit(`attach ${s.name} (browser)`);
  const p = parseSessionName(s.name, d.dist())!;
  // D54: how many browsers view this session now, this one included: a
  // lone viewer sizes the PTY; another one follows the size in use.
  const set = VIEWERS.get(s.ref.id) ?? new Set();
  VIEWERS.set(s.ref.id, set);
  set.add(ws);
  const viewers = set.size;
  ws.send(
    JSON.stringify({
      type: "session",
      id: s.ref.id,
      name: s.name,
      workspace: p.workspace,
      label: p.name,
      viewers,
      exited: s.exited === true,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    }),
  );
  // The others hear there's one more (it follows: D54).
  tellViewers(s.ref.id);
  let exited = s.exited === true;
  const att = client.attach(s.ref.id, {
    onData: (data) => ws.send(data),
    onSize: (cols, rows) => {
      if (ws.open) ws.send(JSON.stringify({ type: "size", cols, rows }));
    },
    onExit: (exitCode) => {
      exited = true;
      ws.send(
        JSON.stringify({
          type: "exit",
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      );
    },
  });
  att.ready.catch((e: Error) => {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
    ws.close(WS_CLOSE.internal, "attach failed");
  });
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (binary) {
      if (!exited && data.length) client.write(s.ref.id, data);
      return;
    }
    let msg: { type?: unknown; cols?: unknown; rows?: unknown; data?: unknown };
    try {
      msg = JSON.parse(data.toString("utf-8")) as typeof msg;
    } catch {
      return;
    }
    if (msg?.type === "resize") {
      // Never below 2x2: a pane measured before it was laid out.
      const ok = (n: unknown): n is number =>
        typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= 1000;
      if (!exited && ok(msg.cols) && ok(msg.rows))
        client.resize(s.ref.id, msg.cols, msg.rows);
    } else if (msg?.type === "input" && typeof msg.data === "string") {
      if (!exited && msg.data)
        client.write(s.ref.id, Buffer.from(msg.data, "utf-8"));
    }
  });
  let done = false;
  const detach = () => {
    if (done) return;
    done = true;
    const viewing = VIEWERS.get(s.ref.id);
    viewing?.delete(ws);
    if (viewing?.size) tellViewers(s.ref.id);
    else VIEWERS.delete(s.ref.id);
    // Detach only: the session keeps running in the host.
    att.detach();
    client.close();
    audit(
      `detach ${s.name} (browser, ${Math.round((Date.now() - since) / 1000)}s)`,
    );
  };
  ws.on("close", detach);
  client.once("close", () => {
    if (ws.open) ws.close(WS_CLOSE.goingAway, "the session host went away");
    detach();
  });
}

/**
 * D32: `GET /api/sessions/helpers`: how many helpers the active
 * workspaces' agents have running now, `{ running }` (the rail's Agents
 * badge on every page). Names and counts only, never a transcript.
 */
async function helpersRunning(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SessionRouteDeps,
): Promise<true> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, { ok: false, error: "method not allowed" }, 405);
    return true;
  }
  const d = resolve(deps);
  let sessions: SessionInfo[] = [];
  try {
    const c = await d.connectExisting();
    if (c)
      try {
        sessions = await c.list();
      } finally {
        c.close();
      }
  } catch {
    /* no host: nothing runs, so no helper runs */
  }
  let running = 0;
  for (const r of listedSessions(sessions, d))
    running += r.helpers?.running ?? 0;
  sendJson(res, { running });
  return true;
}
