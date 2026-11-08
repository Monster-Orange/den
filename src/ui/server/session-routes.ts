/**
 * The Agents tab's routes (AG-4a-term, AG spec §5d):
 *
 *   GET /api/sessions            every session and agent in the active
 *                                workspaces (read-only class)
 *   WS  /api/sessions/<id>/io    a session's terminal (shell-grade)
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
import type * as http from "http";
import type { Duplex } from "stream";
import {
  getActiveWorkspaces,
  readWorkspacesFile,
} from "../../shared/environment-manager/workspaces.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { revokedAgentIds } from "../../shared/actor-token.js";
import { listRecords } from "../../shared/agents/records.js";
import { softNewlineSeq } from "../../shared/agents/catalog.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import type { RotationInfo } from "../../shared/agents/rotation.js";
import {
  connectHost,
  noHost,
  type HostClient,
} from "../../shared/sessions/client.js";
import { parseSessionName } from "../../shared/sessions/names.js";
import { sessionPaths } from "../../shared/sessions/paths.js";
import { loadPty, type PtyLoad } from "../../shared/sessions/pty.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { agentRows, newerOf, noteEnded } from "../cli/agent-ops.js";
import type { Override } from "../../shared/agents/records.js";
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
}

interface Resolved {
  stateDir: () => string;
  dist: () => string;
  connectExisting: () => Promise<HostClient | null>;
  activeWorkspaces: () => string[];
  workspaceExists: (ws: string) => boolean;
  pty: () => PtyLoad;
  waitingAgents: () => ReadonlySet<string>;
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
  };
}

/** The subprotocol the io route answers with. */
export const IO_PROTOCOL = "den.io";

const IO_PATH = /^\/api\/sessions\/([^/]+)\/io$/;

/** One row of the Agents tab's list. */
export interface ListedSession {
  /** The session host's id; for an agent with no session, its last one. */
  id: string;
  /** `<dist>-<ws>:<name>`. */
  name: string;
  workspace: string;
  kind: "agent" | "session";
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
   * ESC CR unless the runtime says otherwise. A plain session: none (Enter).
   */
  softNewline?: string;
  persona?: string;
  runtime?: string;
  model?: string;
  /** A pinned model version (AG-12), and the newer one when there is. */
  version?: string;
  newer?: string;
  /** Its permission intent (AG-13): ask, edits, all. */
  permission?: string;
  /** Extra allowed commands it was started with (AG-13.3). */
  allow?: string[];
  /** What it overrides of its persona (AG-10.9): its row's tags. */
  overrides?: Override[];
  cwd?: string;
  /** running, stopping, exited (<code>), stopped, interrupted (AG-14). */
  state: string;
  exited: boolean;
  exitCode?: number;
  startedAt?: string;
  /** The host has it (running, or ended with its scrollback): a pane can attach. */
  attachable: boolean;
  resumable?: boolean;
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
}

/** The list, from the host's sessions and the agent records. */
export function listedSessions(
  sessions: SessionInfo[],
  d: Pick<Resolved, "stateDir" | "dist" | "activeWorkspaces"> &
    Partial<Pick<Resolved, "waitingAgents">>,
  /** A workspace asked for by name (`?ws=`), listed even when inactive. */
  also?: string,
): ListedSession[] {
  const dist = d.dist();
  const active = new Set(d.activeWorkspaces());
  if (also) active.add(also);
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
  for (const r of agentRows(mine, records, d.stateDir())) {
    const rec = records.find((x) => x.id === r.agent)!;
    const s = r.session;
    if (s) agentSessions.add(s.ref.id);
    out.push({
      id: s?.ref.id ?? rec.session.id,
      name: s?.name ?? rec.sessionName,
      workspace: rec.workspace,
      kind: "agent",
      label: rec.id,
      agent: rec.id,
      ...(rec.displayName ? { displayName: rec.displayName } : {}),
      ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
      softNewline: softNewlineSeq(getRuntime(rec.runtime)?.catalog),
      persona: rec.persona,
      runtime: rec.runtime,
      ...(rec.model ? { model: rec.model } : {}),
      ...(rec.version ? { version: rec.version } : {}),
      ...newerOf(rec),
      ...(rec.permission ? { permission: rec.permission } : {}),
      ...(rec.allow?.length ? { allow: [...rec.allow] } : {}),
      ...(rec.overrides?.length ? { overrides: [...rec.overrides] } : {}),
      cwd: rec.cwd,
      state: r.state,
      exited: !s || s.exited === true,
      ...(s?.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
      attachable: Boolean(s),
      resumable: r.resumable,
      ...(r.noResume ? { noResume: r.noResume } : {}),
      ...(r.stoppedAt ? { stoppedAt: r.stoppedAt } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.interruptedAt ? { interruptedAt: r.interruptedAt } : {}),
      ...(r.rotation?.due ? { rotation: r.rotation } : {}),
      ...(revoked.has(rec.id) && s && !s.exited ? { tokenRevoked: true } : {}),
      ...(waiting.has(rec.id) && s && !s.exited ? { waiting: true } : {}),
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
      state: sessionState(s),
      exited: s.exited === true,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
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
    ),
    workspaces: d.activeWorkspaces(),
    ...(wanted ? { requested: wanted } : {}),
    host,
    ...(hostError ? { hostError } : {}),
    backend: pty.available
      ? { id: "den-pty", available: true }
      : { id: "den-pty", available: false, reason: pty.reason },
    io: { allowed: ioAllowed },
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
 * A plain HTTP request to an io route: it is a WebSocket. 426 for a GET,
 * 404 for anything else under /api/sessions/.
 */
export function sendSessionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): void {
  if (
    IO_PATH.test(pathname) &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
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
    const dist = d.dist();
    const active = new Set(d.activeWorkspaces());
    info = (await client.list()).find((s) => {
      const p = parseSessionName(s.name, dist);
      return (
        p !== null &&
        active.has(p.workspace) &&
        (s.ref.id === target || s.name === target)
      );
    });
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
  ws.send(
    JSON.stringify({
      type: "session",
      id: s.ref.id,
      name: s.name,
      workspace: p.workspace,
      label: p.name,
      exited: s.exited === true,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    }),
  );
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
