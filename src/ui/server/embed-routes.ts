/**
 * Issue 103: the embedded agent pane, its routes.
 *
 *   GET  /embed/p/<project>/agents/<id>  the pane, for a frame. Only the
 *        origins in Settings › Embedding may frame it (frameHeaders:
 *        frame-ancestors); sign-in free, and it holds no data: it learns
 *        everything with its key.
 *   GET  /embed/connect?project=&agent=&origin=  beyond this computer, the
 *        frame has no cookie: this pop-up (a Den page, signed in) asks the
 *        person to allow the host, mints the key and hands it to the frame
 *        that opened it (postMessage to Den's own origin only).
 *   POST /api/embed/keys  { project, agent, origin }  a key for the frame,
 *        minted for the person (on this computer, or signed in): never an
 *        agent's. The origin must be on the list, exactly. 403
 *        origin_not_listed, 404 no_agent.
 *   POST /api/embed/say   { text, context? }, the key in X-Den-Embed-Key:
 *        typed into the key's agent, then Enter; each shared page after the
 *        text as quoted data from the key's origin (shared-page.ts). Sign-in and CSRF free: the key is
 *        the proof (a custom header, which no other site can send without
 *        Den's CORS, and Den has none). 401 bad_key / key_expired; 403
 *        origin_not_listed when the host was taken off the list since.
 *
 *        Issue 334: with an app key (embed-server-keys.ts) instead, from
 *        the web app's own server: the message is held by the delivery
 *        loop Hub's inbox uses and typed after the agent's turn, at its
 *        next start when it's stopped, never while it waits on its
 *        person, never mid-turn. 202 { queued: true }.
 *   GET  /api/embed/p/<project>/agents/<id>/state  issue 334: the agent's
 *        state for a web app's server, with its server key
 *        (embed-server-keys.ts) in X-Den-Embed-Key: running or not, and
 *        stopped, busy, idle or waiting (with what it waits on). The key's
 *        own agent only: another is 403 key_scope. 401 bad_key /
 *        key_revoked; 403 origin_not_listed.
 *
 * Every key mint and every message is audited (its length, never its text).
 * The embed key reaches nothing else (request-guard.ts, EMBED_KEY_ROUTES).
 */
import { line, reviewLines } from "../../shared/review-lines.js";
import type * as http from "http";
import * as path from "path";
import { WORKSPACE_NAME_RE, type Actor } from "../../shared/agent-actor.js";
import {
  AGENT_ID_RE,
  readRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import { AgentError, type AgentsResolved } from "../cli/agent-ops.js";
import { sayBody, typeMessage } from "./agent-say.js";
import { composeMessage } from "./shared-page.js";
import type { HeldOp } from "./held-actions.js";
import { recordAction } from "./audit.js";
import { EMBED_KEY_HEADER, EmbedKeys } from "./embed-keys.js";
import {
  SERVER_KEY_PREFIX,
  ServerKeys,
  type ServerKeyView,
} from "./embed-server-keys.js";
import { embedDelivery, type Delivery } from "../../shared/hub-delivery.js";
import { randomBytes } from "crypto";
import {
  checkOrigin,
  embedSettings,
  originListed,
  type EmbedSettings,
} from "./embed-settings.js";
import { readBody, sendJson } from "./http-helpers.js";
import { readUserConfig } from "../../shared/den-config.js";

const EMBED_PATH = /^\/embed\/p\/([^/]+)\/agents\/([^/]+)\/?$/;
const STATE_PATH = /^\/api\/embed\/p\/([^/]+)\/agents\/([^/]+)\/state$/;

export interface EmbedDeps {
  settings(): EmbedSettings;
  agents(): AgentsResolved;
  stateDir(): string;
  publicDir: string;
  /** A page from public/, filled as every page is, `fill` applied first. */
  servePage(
    res: http.ServerResponse,
    file: string,
    fill?: (html: string) => string,
  ): void;
  /** The request's credential: an agent's (refused here), or a person's. */
  agentCaller(req: http.IncomingMessage): boolean;
  actor(req: http.IncomingMessage): Actor;
  principal(req: http.IncomingMessage): string | undefined;
  /** Issue 334: the server keys (made in Settings › Embedding). */
  serverKeys(): ServerKeys;
  /** Issue 334: whether the agent can take a message now (agent-ops). */
  inputState(id: string): Promise<"missing" | "stopped" | "busy" | "idle">;
  /** Issue 334: what the agent waits on for its person, or null. */
  waitingOf(id: string): EmbedWaiting | null;
  /**
   * Issue 334: hold a relayed message in the delivery loop (typed after
   * the agent's turn). False when the loop isn't running yet.
   */
  relay(dv: Delivery): Promise<boolean>;
  /** Issue 334: where an app key's reads are audited (a test's own). */
  appKeyUses?: AppKeyUseAudit;
}

/** The request's path, never its query (nothing a host sent in it). */
const routeOf = (req: http.IncomingMessage) =>
  new URL(req.url ?? "/", "http://localhost").pathname.slice(0, 300);

/** Issue 334: what an agent waits on (attention.ts, a held Allow, a pause). */
export interface EmbedWaiting {
  why: string;
  what?: string;
  since?: string;
}

export type EmbedAgentState = "stopped" | "busy" | "idle" | "waiting";

/** Issue 334: what the state route says, from the input state and the wait. */
export function embedStateView(
  input: "missing" | "stopped" | "busy" | "idle",
  waiting: EmbedWaiting | null,
): { running: boolean; state: EmbedAgentState; waiting?: EmbedWaiting } {
  if (input === "missing" || input === "stopped")
    return { running: false, state: "stopped" };
  if (waiting) return { running: true, state: "waiting", waiting };
  return { running: true, state: input };
}

/** One store per server: keys live in memory only. */
export const EMBED_KEYS = new EmbedKeys();

const KEYS_BODY = 4 * 1024;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function fail(
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
): true {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, { ok: false, code, error }, status);
  return true;
}

/** The project's own agent `id`, or null (another project's is none). */
function agentOf(
  stateDir: string,
  project: unknown,
  agent: unknown,
): AgentRecord | null {
  if (typeof project !== "string" || !WORKSPACE_NAME_RE.test(project))
    return null;
  if (typeof agent !== "string" || !AGENT_ID_RE.test(agent)) return null;
  const rec = readRecord(stateDir, agent);
  return rec && rec.workspace === project ? rec : null;
}

const nameOf = (rec: AgentRecord) =>
  rec.displayName ||
  (rec.persona && rec.persona !== rec.id ? rec.persona : rec.id);

/** The pane's config, as JSON a <script type="application/json"> holds. */
export function embedConfigJson(c: {
  project: string;
  agent: string;
  origins: readonly string[];
  limits?: { context_max_bytes: number; url_max_chars: number };
}): string {
  return JSON.stringify(c).replace(/</g, "\\u003c");
}

export async function handleEmbedRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: EmbedDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const page = EMBED_PATH.exec(pathname);
  if (page) {
    if (method !== "GET" && method !== "HEAD")
      return fail(res, 405, "method", "GET only");
    const project = decode(page[1]);
    const agent = decode(page[2]);
    if (
      project === null ||
      agent === null ||
      !WORKSPACE_NAME_RE.test(project) ||
      !AGENT_ID_RE.test(agent)
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }
    const set = deps.settings();
    const json = embedConfigJson({
      project,
      agent,
      origins: set.origins,
      // Issue 103: what a shared page may be (checked again on Send).
      limits: {
        context_max_bytes: set.context_max_kb * 1024,
        url_max_chars: set.url_max_chars,
      },
    });
    res.setHeader("Referrer-Policy", "no-referrer");
    deps.servePage(res, path.join(deps.publicDir, "embed.html"), (html) =>
      html.replace("@@DEN_EMBED@@", () => json),
    );
    return true;
  }
  if (pathname === "/embed/connect") {
    if (method !== "GET" && method !== "HEAD")
      return fail(res, 405, "method", "GET only");
    res.setHeader("Referrer-Policy", "no-referrer");
    deps.servePage(res, path.join(deps.publicDir, "embed-connect.html"));
    return true;
  }
  if (pathname === "/api/embed/keys") {
    if (method !== "POST") return fail(res, 405, "method", "POST only");
    return mintKey(req, res, deps);
  }
  if (pathname === "/api/embed/say") {
    if (method !== "POST") return fail(res, 405, "method", "POST only");
    return say(req, res, deps);
  }
  if (handleAppKeyList(req, res, pathname, deps)) return true;
  const st = STATE_PATH.exec(pathname);
  if (st) {
    if (method !== "GET" && method !== "HEAD")
      return fail(res, 405, "method", "GET only");
    return agentState(req, res, deps, decode(st[1]), decode(st[2]));
  }
  return false;
}

/**
 * Issue 334: the server key in X-Den-Embed-Key, checked: still Den's, not
 * revoked, its origin still listed, and the request's Origin (a server
 * sends none) its own. Answers the refusal itself: null then.
 */
function serverKeyOf(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EmbedDeps,
): ServerKeyView | null {
  const raw = req.headers[EMBED_KEY_HEADER];
  const c = deps.serverKeys().check(Array.isArray(raw) ? raw[0] : raw);
  if (!c.ok) {
    fail(
      res,
      401,
      c.code,
      c.code === "key_revoked"
        ? "This app key was revoked in Settings › Embedding."
        : "This request has no valid app key.",
    );
    return null;
  }
  const k = c.key;
  const refuse = (code: string, error: string, reason: string) => {
    recordAction(
      null,
      {
        verb: "embed",
        detail: `app key ${k.id} for ${k.agent}`,
        targetWorkspace: k.project,
        outcome: "refused",
        reason,
      },
      `embed:${k.origin}`,
    );
    fail(res, 403, code, error);
    return null;
  };
  if (!originListed(k.origin, deps.settings().origins))
    return refuse(
      "origin_not_listed",
      `${k.origin} is no longer on Settings › Embedding's list.`,
      "origin taken off the list",
    );
  const sent = req.headers.origin;
  if (typeof sent === "string" && sent !== k.origin)
    return refuse(
      "origin_mismatch",
      `This key is for ${k.origin}, not ${sent}.`,
      "another origin",
    );
  return k;
}

/** Issue 334: how an app key's read ended. */
export type AppKeyOutcome = "ok" | "refused";

interface UseWindow {
  key: Pick<ServerKeyView, "id" | "project" | "origin">;
  route: string;
  outcome: AppKeyOutcome;
  reason?: string;
  from: number;
  count: number;
}

/**
 * Issue 334: an app key's state reads, audited. A read is a use: the
 * key's id, the route, when, and how it ended; never the key, never a
 * body. A polling app would flood the trail, so reads coalesce: one line
 * per key, route and outcome per window (Settings › Embedding,
 * embed.app_key_audit_window_seconds), with how many there were. A
 * window's line is written when it ends: at the next read after it, or
 * by the sweep (every window, on a timer that never holds the process).
 */
export class AppKeyUseAudit {
  private readonly open = new Map<string, UseWindow>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(
    private readonly d: {
      windowMs: () => number;
      write: (a: {
        detail: string;
        targetWorkspace: string;
        origin: string;
        outcome?: "refused";
        reason?: string;
      }) => void;
      now?: () => number;
      /** False in a test: it sweeps by hand. */
      timers?: boolean;
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  private emit(w: UseWindow): void {
    try {
      this.d.write({
        detail: `app key ${w.key.id} read ${w.route}: ${w.count} read${w.count === 1 ? "" : "s"}, ${w.outcome}, from ${new Date(w.from).toISOString()}`,
        targetWorkspace: w.key.project,
        origin: w.key.origin,
        ...(w.outcome === "refused"
          ? { outcome: "refused" as const, reason: w.reason ?? "refused" }
          : {}),
      });
    } catch {
      /* the trail's trouble never fails a read */
    }
  }

  /** One read with `key` on `route`. */
  note(
    key: Pick<ServerKeyView, "id" | "project" | "origin">,
    route: string,
    outcome: AppKeyOutcome,
    reason?: string,
  ): void {
    const t = this.now();
    const id = `${key.id}\n${route}\n${outcome}`;
    const w = this.open.get(id);
    if (w && t - w.from < this.d.windowMs()) {
      w.count++;
      return;
    }
    if (w) this.emit(w);
    this.open.set(id, {
      key,
      route,
      outcome,
      ...(reason ? { reason } : {}),
      from: t,
      count: 1,
    });
    this.arm();
  }

  /** Write every window that has ended. */
  sweep(): void {
    const t = this.now();
    const ms = this.d.windowMs();
    for (const [id, w] of this.open)
      if (t - w.from >= ms) {
        this.open.delete(id);
        this.emit(w);
      }
    if (!this.open.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (this.d.timers === false || this.timer) return;
    this.timer = setInterval(
      () => this.sweep(),
      Math.min(Math.max(this.d.windowMs(), 1000), 60_000),
    );
    this.timer.unref?.();
  }
}

/** One per server: the trail's lines for app-key reads. */
const APP_KEY_USES = new AppKeyUseAudit({
  windowMs: () =>
    embedSettings(readUserConfig()).app_key_audit_window_seconds * 1000,
  write: (a) =>
    recordAction(
      null,
      {
        verb: "embed",
        detail: a.detail,
        targetWorkspace: a.targetWorkspace,
        ...(a.outcome ? { outcome: a.outcome, reason: a.reason } : {}),
      },
      `embed:${a.origin}`,
    ),
});

async function agentState(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EmbedDeps,
  project: string | null,
  agent: string | null,
): Promise<boolean> {
  const k = serverKeyOf(req, res, deps);
  if (!k) return true;
  const uses = deps.appKeyUses ?? APP_KEY_USES;
  if (project !== k.project || agent !== k.agent) {
    uses.note(k, routeOf(req), "refused", "another agent");
    return fail(res, 403, "key_scope", "This key reaches only its own agent.");
  }
  const rec = agentOf(deps.stateDir(), k.project, k.agent);
  if (!rec)
    return fail(
      res,
      404,
      "no_agent",
      `Project ${k.project} has no agent ${k.agent}.`,
    );
  deps.serverKeys().touch(k.id);
  uses.note(k, routeOf(req), "ok");
  const v = embedStateView(
    await deps.inputState(rec.id),
    deps.waitingOf(rec.id),
  );
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, {
    ok: true,
    agent: { id: rec.id, project: rec.workspace, name: nameOf(rec) },
    ...v,
  });
  return true;
}

async function mintKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EmbedDeps,
): Promise<boolean> {
  const actor = deps.actor(req);
  const audit = (detail: string, reason?: string) =>
    recordAction(
      actor,
      {
        verb: "embed",
        detail,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      deps.principal(req),
    );
  if (deps.agentCaller(req) || actor) {
    audit("embed key", "an agent asked");
    return fail(
      res,
      403,
      "agent_forbidden",
      "Only a person can let a web app use an agent.",
    );
  }
  const raw = await readBody(req).catch(() => "");
  if (raw.length > KEYS_BODY)
    return fail(res, 413, "too_large", "request too large");
  let b: { project?: unknown; agent?: unknown; origin?: unknown };
  try {
    b = JSON.parse(raw || "{}") as typeof b;
  } catch {
    return fail(
      res,
      400,
      "usage",
      "the body must be JSON: { project, agent, origin }",
    );
  }
  if (!b || typeof b !== "object")
    return fail(res, 400, "usage", "the body must be an object");
  const o = checkOrigin(b.origin);
  const s = deps.settings();
  if (!o.ok || !originListed(o.origin, s.origins)) {
    audit(
      `embed key for ${String(b.agent)} from ${String(b.origin)}`,
      "origin not listed",
    );
    return fail(
      res,
      403,
      "origin_not_listed",
      `${String(b.origin)} is not on Settings › Embedding's list, so it can't use this agent.`,
    );
  }
  const rec = agentOf(deps.stateDir(), b.project, b.agent);
  if (!rec)
    return fail(
      res,
      404,
      "no_agent",
      `Project ${String(b.project)} has no agent ${String(b.agent)}.`,
    );
  const { key, expiresAt } = EMBED_KEYS.mint(
    { project: rec.workspace, agent: rec.id, origin: o.origin },
    s.key_minutes * 60_000,
  );
  audit(`embed key for ${rec.id} in ${rec.workspace} from ${o.origin}`);
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, {
    ok: true,
    key,
    expiresAt: new Date(expiresAt).toISOString(),
    agent: { id: rec.id, project: rec.workspace, name: nameOf(rec) },
    // What a shared page may be (den:context), checked again on Send.
    limits: {
      context_max_bytes: s.context_max_kb * 1024,
      url_max_chars: s.url_max_chars,
    },
  });
  return true;
}

async function say(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EmbedDeps,
): Promise<boolean> {
  const raw = req.headers[EMBED_KEY_HEADER];
  const sent = Array.isArray(raw) ? raw[0] : raw;
  if (typeof sent === "string" && sent.startsWith(SERVER_KEY_PREFIX))
    return relaySay(req, res, deps);
  const c = EMBED_KEYS.check(sent);
  if (!c.ok)
    return fail(
      res,
      401,
      c.code,
      c.code === "key_expired"
        ? "This pane's key expired. It asks for a new one."
        : "This pane has no valid key.",
    );
  const g = c.grant;
  const audit = (detail: string, reason?: string) =>
    recordAction(
      null,
      {
        verb: "embed",
        detail,
        targetWorkspace: g.project,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      `embed:${g.origin}`,
    );
  if (!originListed(g.origin, deps.settings().origins)) {
    audit(`message to ${g.agent}`, "origin taken off the list");
    return fail(
      res,
      403,
      "origin_not_listed",
      `${g.origin} is no longer on Settings › Embedding's list.`,
    );
  }
  const rec = agentOf(deps.stateDir(), g.project, g.agent);
  if (!rec)
    return fail(
      res,
      404,
      "no_agent",
      `Project ${g.project} has no agent ${g.agent}.`,
    );
  try {
    const s = deps.settings();
    const { text, pages } = await sayBody(req, {
      urlMax: s.url_max_chars,
      maxBytes: s.context_max_kb * 1024,
    });
    const message = composeMessage(text, pages, g.origin);
    await typeMessage(deps.agents(), rec, message);
    audit(
      `message to ${rec.id} in ${rec.workspace} (${message.length} characters, ${pages.length} shared page${pages.length === 1 ? "" : "s"})`,
    );
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, { ok: true });
  } catch (e) {
    const err = e as AgentError;
    audit(`message to ${rec.id}`, err.message);
    return fail(
      res,
      err instanceof AgentError ? err.status : 500,
      (err instanceof AgentError && err.code) ||
        (err.usage ? "usage" : "failed"),
      err.message,
    );
  }
  return true;
}

/**
 * Issue 334: a web app's server relays its person's message (they pressed
 * Send in the app's own page). Held by the delivery loop, never typed
 * mid-turn. Audited with its length, never its text.
 */
async function relaySay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: EmbedDeps,
): Promise<boolean> {
  const k = serverKeyOf(req, res, deps);
  if (!k) return true;
  const audit = (detail: string, reason?: string) =>
    recordAction(
      null,
      {
        verb: "embed",
        detail,
        targetWorkspace: k.project,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      `embed:${k.origin}`,
    );
  const rec = agentOf(deps.stateDir(), k.project, k.agent);
  if (!rec)
    return fail(
      res,
      404,
      "no_agent",
      `Project ${k.project} has no agent ${k.agent}.`,
    );
  try {
    const s = deps.settings();
    const { text, pages } = await sayBody(req, {
      urlMax: s.url_max_chars,
      maxBytes: s.context_max_kb * 1024,
    });
    const message = composeMessage(text, pages, k.origin);
    const id = randomBytes(9).toString("base64url");
    const held = await deps.relay(
      embedDelivery({
        id,
        agent: rec.id,
        project: rec.workspace,
        origin: k.origin,
        text: message,
        at: Date.now(),
      }),
    );
    if (!held) {
      audit(`message to ${rec.id} with app key ${k.id}`, "not ready");
      return fail(
        res,
        503,
        "not_ready",
        "Den is still starting. Send it again in a moment.",
      );
    }
    deps.serverKeys().touch(k.id);
    audit(
      `message to ${rec.id} in ${rec.workspace} with app key ${k.id} (${message.length} characters, ${pages.length} shared page${pages.length === 1 ? "" : "s"}): held until its turn ends`,
    );
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, { ok: true, queued: true, id }, 202);
  } catch (e) {
    const err = e as AgentError;
    audit(`message to ${rec.id} with app key ${k.id}`, err.message);
    return fail(
      res,
      err instanceof AgentError ? err.status : 500,
      (err instanceof AgentError && err.code) ||
        (err.usage ? "usage" : "failed"),
      err.message,
    );
  }
  return true;
}

/** Issue 334: what the app-key held writes need. */
export interface AppKeyDeps {
  settings(): EmbedSettings;
  stateDir(): string;
  serverKeys(): ServerKeys;
}

const LABEL_MAX = 80;

/** A label: one line of plain text, or none. */
function labelOf(v: unknown): string | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return null;
  // A one-line label: no control characters. Intentional.
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  return t.length <= LABEL_MAX ? t || undefined : null;
}

/**
 * Issue 334: Settings › Embedding's app keys, as held writes: made and
 * revoked only on the person's own Allow (an agent never asks for one).
 * The new key is in the run's result under `once`: the decide route hands
 * it to the Allow's browser and then forgets it (approval-routes.ts).
 */
export function appKeyOps(d: AppKeyDeps): {
  create: HeldOp;
  revoke: HeldOp;
} {
  const noAgents = {
    ok: false as const,
    error:
      "Only a person makes or revokes an app key, in Settings › Embedding.",
  };
  const create: HeldOp = {
    check(a, who) {
      if (who?.agent) return noAgents;
      const o = checkOrigin(a.origin);
      if (!o.ok) return { ok: false, error: o.error };
      if (!originListed(o.origin, d.settings().origins))
        return {
          ok: false,
          error: `${o.origin} is not on Settings › Embedding's list. Add it there first.`,
        };
      const rec = agentOf(d.stateDir(), a.project, a.agent);
      if (!rec)
        return {
          ok: false,
          error: `Project ${String(a.project)} has no agent ${String(a.agent)}.`,
        };
      const label = labelOf(a.label);
      if (label === null)
        return {
          ok: false,
          error: `A key's name is one line of at most ${LABEL_MAX} characters.`,
        };
      return {
        ok: true,
        personOnly: true,
        args: {
          project: rec.workspace,
          agent: rec.id,
          origin: o.origin,
          ...(label ? { label } : {}),
        },
        summary: `let ${o.origin} message ${rec.id} in ${rec.workspace} and read its state`,
        params: { agent: rec.id, project: rec.workspace, origin: o.origin },
        ...reviewLines([
          line(
            `Makes a key for ${o.origin}'s own backend. It reaches only ${rec.id} in ${rec.workspace}: its state, and messages typed after its turn ends.`,
            "ap.det.embed_key_create.reach",
            { origin: o.origin, agent: rec.id, project: rec.workspace },
          ),
          line(
            "The key is shown once, here, after you allow. Den keeps only its hash.",
            "ap.det.embed_key_create.once",
          ),
          line(
            "You can revoke it any time in Settings › Embedding.",
            "ap.det.embed_key_create.revoke",
          ),
        ]),
      };
    },
    run(a) {
      const { key, view } = d.serverKeys().create({
        project: String(a.project),
        agent: String(a.agent),
        origin: String(a.origin),
        ...(typeof a.label === "string" ? { label: a.label } : {}),
      });
      recordAction(null, {
        verb: "embed",
        detail: `app key ${view.id} made for ${view.agent} in ${view.project} from ${view.origin}`,
        targetWorkspace: view.project,
      });
      return Promise.resolve({ ok: true, ...view, once: { key } });
    },
  };
  const revoke: HeldOp = {
    check(a, who) {
      if (who?.agent) return noAgents;
      const k = d.serverKeys().get(a.id);
      if (!k)
        return { ok: false, error: `There is no app key ${String(a.id)}.` };
      if (k.revokedAt)
        return { ok: false, error: `App key ${k.id} was revoked already.` };
      return {
        ok: true,
        personOnly: true,
        args: { id: k.id },
        summary: `revoke ${k.origin}'s key for ${k.agent} in ${k.project}`,
        params: { agent: k.agent, project: k.project, origin: k.origin },
        ...reviewLines([
          line(
            `${k.origin} can no longer message ${k.agent} or read its state with this key.`,
            "ap.det.embed_key_revoke.reach",
            { origin: k.origin, agent: k.agent },
          ),
          line(
            "Messages it sent that wait for the agent's turn are still typed.",
            "ap.det.embed_key_revoke.held",
          ),
        ]),
      };
    },
    run(a) {
      const v = d.serverKeys().revoke(a.id);
      if (!v)
        return Promise.resolve({
          ok: false,
          error: `There is no app key ${String(a.id)} to revoke.`,
        });
      recordAction(null, {
        verb: "embed",
        detail: `app key ${v.id} revoked for ${v.agent} in ${v.project} from ${v.origin}`,
        targetWorkspace: v.project,
      });
      return Promise.resolve({ ok: true, ...v });
    },
  };
  return { create, revoke };
}

/**
 * Issue 334: GET /api/embed/app-keys, the person's list (Settings ›
 * Embedding): each key's agent, origin, name, made, last used, revoked.
 * Never a key or its hash. An agent's token is refused (AGENT_FORBIDDEN).
 */
export function handleAppKeyList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: Pick<EmbedDeps, "serverKeys" | "agentCaller">,
): boolean {
  if (pathname !== "/api/embed/app-keys") return false;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD")
    return fail(res, 405, "method", "GET only");
  if (d.agentCaller(req))
    return fail(
      res,
      403,
      "agent_forbidden",
      "Only a person sees the app keys.",
    );
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, { ok: true, keys: d.serverKeys().list() });
  return true;
}
