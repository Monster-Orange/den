/**
 * Issue 620: a session that isn't a Den agent asks the person a yes/no
 * (or a few named choices); see shared/session-asks.ts.
 *
 *   POST /api/session-asks              file one (the person token, from a
 *                                       process Den places; never an agent)
 *   GET  /api/session-asks/:id          its state and answer: the filing
 *                                       process only; anyone else: 404
 *   POST /api/session-asks/:id/answer   the person's signed-in browser only
 *
 * An agent's token never reaches the writes (request-guard.ts lists them as
 * a person's). Answering runs nothing: it records the choice for the asker.
 */
import type * as http from "http";
import type { GuardResult } from "./request-guard.js";
import { approverAllowed } from "./approvals.js";
import { sendJson } from "./http-helpers.js";
import {
  answerAsk,
  askById,
  askFor,
  fileAsk,
  openAsks,
  parseAskInput,
  type AskCaller,
  type AskLimits,
  type SessionAsk,
  type SessionAskStore,
} from "../../shared/session-asks.js";
import type { ProcessInfo } from "../../shared/process-info.js";

export const SESSION_ASKS_PATH = "/api/session-asks";
export const ONE_PATH = /^\/api\/session-asks\/(sa_[0-9a-f]{24})$/;
export const ANSWER_PATH = /^\/api\/session-asks\/(sa_[0-9a-f]{24})\/answer$/;

export function isSessionAskPath(p: string): boolean {
  return p === SESSION_ASKS_PATH || p.startsWith(`${SESSION_ASKS_PATH}/`);
}

export interface SessionAskDeps {
  store: SessionAskStore;
  limits: () => AskLimits;
  /** Why this caller isn't the person at this machine, or null (sign-in's check). */
  personCallerWhy: (req: http.IncomingMessage) => Promise<string | null>;
  /** The caller's pid (the peer of its connection), once found. */
  callerPid: (req: http.IncomingMessage) => number | null;
  /** What Den reads of a process (start, uid, command, folder). */
  processInfo: (pid: number) => ProcessInfo | null;
  /** This server's own uid. */
  uid: () => number;
  audit: (
    req: http.IncomingMessage,
    a: { verb: string; detail: string; refused?: string },
  ) => void;
  now?: () => number;
}

const refuse = (
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
) => sendJson(res, { ok: false, code, error }, status);

/** The bound process, as Den reads it now: still the same one? */
export function aliveWith(
  info: (pid: number) => ProcessInfo | null,
): (c: AskCaller) => boolean {
  return (c) => info(c.pid)?.started === c.started;
}

/** One ask, as the bell's Needs you shows it (kind session_ask). */
export function sessionAskWaiting(a: SessionAsk) {
  return {
    kind: "session_ask" as const,
    id: a.id,
    question: a.question,
    choices: a.choices,
    ...(a.label ? { label: a.label } : {}),
    caller: {
      pid: a.caller.pid,
      ...(a.caller.command ? { command: a.caller.command } : {}),
      ...(a.caller.cwd ? { cwd: a.caller.cwd } : {}),
    },
    since: new Date(a.createdAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
  };
}

/** The open asks for Needs you (asks whose process is gone are lost). */
export function sessionAsksWaiting(deps: SessionAskDeps) {
  return openAsks(
    deps.store,
    (deps.now ?? Date.now)(),
    aliveWith(deps.processInfo),
  ).map(sessionAskWaiting);
}

const who = (a: SessionAsk) =>
  `${a.label ? `"${a.label}"` : "a caller outside Den's agents"} (not a Den agent; ${a.caller.command ?? "?"} pid ${a.caller.pid}${a.caller.cwd ? ` in ${a.caller.cwd}` : ""})`;

async function jsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    return null;
  }
}

/** The calling process as an ask's caller, or why it can't be one. */
async function placedCaller(
  req: http.IncomingMessage,
  deps: SessionAskDeps,
): Promise<{ caller: AskCaller } | { why: string; detail?: string }> {
  // Sign-in's own check (on loopback, not forwarded, outside every agent's
  // session and Den's own processes); its words are sign-in's, so the
  // caller is told plainly and the audit keeps them.
  const not = await deps.personCallerWhy(req);
  if (not)
    return {
      why: "Den asks the person only for a coding tool in your own terminal: this caller is inside an agent, a Terminals-page shell or Den itself, or Den couldn't check it",
      detail: not,
    };
  const pid = deps.callerPid(req);
  const info = pid ? deps.processInfo(pid) : null;
  if (!pid || !info) return { why: "Den couldn't place the calling process" };
  if (info.uid !== deps.uid())
    return {
      why: "the calling process belongs to someone else on this computer",
    };
  return {
    caller: {
      pid,
      started: info.started,
      command: info.command,
      ...(info.cwd ? { cwd: info.cwd } : {}),
    },
  };
}

export async function handleSessionAskRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  guard: Extract<GuardResult, { ok: true }>,
  deps: SessionAskDeps,
): Promise<boolean> {
  if (!isSessionAskPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const now = (deps.now ?? Date.now)();
  const alive = aliveWith(deps.processInfo);
  const kind = guard.principal?.kind;

  if (pathname === "/api/session-asks") {
    if (method !== "POST")
      return (refuse(res, 405, "method", "POST only."), true);
    // The person token, as a session's MCP server sends it; never an agent's
    // (the guard refused that already) and never a browser.
    if (kind !== "person") {
      deps.audit(req, {
        verb: "session-ask",
        detail: "filed without the person token",
        refused: "person_token_only",
      });
      return (
        refuse(
          res,
          403,
          "person_token_only",
          "A question from outside Den's agents comes through Den's MCP server (the person token). An agent uses its own ask_human.",
        ),
        true
      );
    }
    const placed = await placedCaller(req, deps);
    if ("why" in placed) {
      deps.audit(req, {
        verb: "session-ask",
        detail: placed.detail ?? placed.why,
        refused: "caller_not_placed",
      });
      return (refuse(res, 403, "caller_not_placed", placed.why), true);
    }
    const parsed = parseAskInput(await jsonBody(req));
    if (!parsed.ok) return (refuse(res, 400, "bad_ask", parsed.error), true);
    let limits: AskLimits;
    try {
      limits = deps.limits();
    } catch (err) {
      return (refuse(res, 500, "bad_config", (err as Error).message), true);
    }
    const r = fileAsk(
      deps.store,
      placed.caller,
      parsed.input,
      limits,
      now,
      alive,
    );
    if (!r.ok) {
      deps.audit(req, {
        verb: "session-ask",
        detail: `pid ${placed.caller.pid}: ${r.error}`,
        refused: r.code,
      });
      return (refuse(res, 429, r.code, r.error), true);
    }
    deps.audit(req, {
      verb: "session-ask",
      detail: `${who(r.ask)} asked ${r.id}: ${r.ask.question} [${r.ask.choices.join(" / ")}]`,
    });
    sendJson(res, {
      ok: true,
      id: r.id,
      expiresAt: new Date(r.ask.expiresAt).toISOString(),
    });
    return true;
  }

  const one = ONE_PATH.exec(pathname);
  if (one) {
    if (method !== "GET" && method !== "HEAD")
      return (refuse(res, 405, "method", "GET only."), true);
    const placed =
      kind === "person"
        ? await placedCaller(req, deps)
        : { why: "not the asker" };
    // Anyone but the filing process: as if there were no such ask.
    const a =
      "caller" in placed
        ? askFor(deps.store, one[1], placed.caller, now, alive)
        : null;
    if (!a) return (refuse(res, 404, "no_such_ask", "No such question."), true);
    sendJson(res, {
      ok: true,
      id: a.id,
      state: a.state,
      question: a.question,
      choices: a.choices,
      ...(a.answer ? { answer: a.answer } : {}),
      expiresAt: new Date(a.expiresAt).toISOString(),
    });
    return true;
  }

  const ans = ANSWER_PATH.exec(pathname);
  if (ans) {
    if (method !== "POST")
      return (refuse(res, 405, "method", "POST only."), true);
    // The person's signed-in browser only: never the person token the
    // asker holds, never an agent (approvals' own rule).
    const ok = approverAllowed(req, guard);
    if (!ok.ok) {
      deps.audit(req, {
        verb: "session-ask-answer",
        detail: `${ans[1]}: not the person's signed-in browser`,
        refused: ok.code,
      });
      return (refuse(res, 403, ok.code, ok.error), true);
    }
    const b = (await jsonBody(req)) as { choice?: unknown } | null;
    const r = answerAsk(deps.store, ans[1], b?.choice, now, alive);
    if (!r.ok) {
      const a = askById(deps.store, ans[1], now);
      deps.audit(req, {
        verb: "session-ask-answer",
        detail: `${ans[1]}${a ? ` from ${who(a)}` : ""}: ${r.error}`,
        refused: "not_answerable",
      });
      return (refuse(res, r.status, "not_answerable", r.error), true);
    }
    deps.audit(req, {
      verb: "session-ask-answer",
      detail: `${who(r.ask)}'s ${r.ask.id} answered: ${r.ask.answer}`,
    });
    sendJson(res, { ok: true, id: r.ask.id, answer: r.ask.answer });
    return true;
  }
  refuse(res, 404, "no_route", "No such route.");
  return true;
}
