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
 * Every key mint and every message is audited (its length, never its text).
 */
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
import { recordAction } from "./audit.js";
import { EMBED_KEY_HEADER, EmbedKeys } from "./embed-keys.js";
import {
  checkOrigin,
  originListed,
  type EmbedSettings,
} from "./embed-settings.js";
import { readBody, sendJson } from "./http-helpers.js";

const EMBED_PATH = /^\/embed\/p\/([^/]+)\/agents\/([^/]+)\/?$/;

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
  return false;
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
  const c = EMBED_KEYS.check(Array.isArray(raw) ? raw[0] : raw);
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
