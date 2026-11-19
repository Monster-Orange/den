/**
 * Issue 103: a composer's Send. The person's message is typed into the
 * agent's session over the host's write path (as a first instruction is,
 * AG-10.1): one bracketed paste when the program turned it on, then
 * Enter. Nothing reaches the session before Send.
 *
 *   POST /api/workspaces/<ws>/agents/<id>/say   { text, context? }
 *                                               (a person only)
 *
 * The text is checked as an instruction is (checkInstruction: no control
 * character, no escape sequence, no bidi override, at most 8000
 * characters). `context` is the pages shared with it (shared-page.ts):
 * each reaches the agent after the text as quoted data, never as
 * instructions. A stopped agent, or one whose session ended: 409
 * not_running.
 */
import type * as http from "http";
import {
  AgentError,
  checkInstruction,
  sendFirstInstruction,
  type AgentsResolved,
} from "../cli/agent-ops.js";
import type { AgentRecord } from "../../shared/agents/records.js";
import { readUserConfig } from "../../shared/den-config.js";
import { embedSettings } from "./embed-settings.js";
import { readBody } from "./http-helpers.js";
import {
  MAX_SHARED,
  checkSharedPage,
  composeMessage,
  type SharedPage,
} from "./shared-page.js";

/** What Send may carry: Settings › Embedding's limits. */
export interface SayLimits {
  urlMax: number;
  maxBytes: number;
}

/** The limits now (user.yml embed.*). */
export function sayLimits(): SayLimits {
  const e = embedSettings(readUserConfig());
  return { urlMax: e.url_max_chars, maxBytes: e.context_max_kb * 1024 };
}

/**
 * The message a POST asks to send, checked: `text`, and the pages shared
 * with it (issue 103, `context`: one page or a list), each checked by
 * checkSharedPage. A message needs one or the other.
 */
export async function sayBody(
  req: http.IncomingMessage,
  limits: SayLimits = sayLimits(),
): Promise<{ text: string; pages: SharedPage[] }> {
  const raw = await readBody(req).catch(() => "");
  if (Buffer.byteLength(raw) > 64 * 1024 + MAX_SHARED * limits.maxBytes)
    throw new AgentError("request too large", {
      status: 413,
      code: "context_too_large",
    });
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    throw new AgentError("invalid JSON", { usage: true });
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new AgentError("the body must be an object: { text, context? }", {
      usage: true,
    });
  for (const k of Object.keys(v))
    if (k !== "text" && k !== "context")
      throw new AgentError(`${k}: unknown field (say takes text, context)`, {
        usage: true,
      });
  const b = v as { text?: unknown; context?: unknown };
  const text = checkInstruction(b.text) ?? "";
  const given =
    b.context === undefined || b.context === null
      ? []
      : Array.isArray(b.context)
        ? b.context
        : [b.context];
  if (given.length > MAX_SHARED)
    throw new AgentError(`at most ${MAX_SHARED} shared pages at once`, {
      usage: true,
      code: "context_shape",
    });
  const pages = given.map((c) => checkSharedPage(c, limits));
  if (!text && !pages.length)
    throw new AgentError("write a message first", {
      usage: true,
      code: "empty",
    });
  return { text, pages };
}

/**
 * Type `text` into `rec`'s session and press Enter. Throws 409
 * not_running when it has no live session, and 409 dialog_open when its
 * screen ends with a dialog for its person (nothing typed).
 */
export async function typeMessage(
  d: AgentsResolved,
  rec: AgentRecord,
  text: string,
): Promise<void> {
  if (rec.stoppedAt)
    throw new AgentError(`${rec.id} is stopped. Resume it first.`, {
      status: 409,
      code: "not_running",
    });
  let dialog = false;
  const sent = await sendFirstInstruction(
    d,
    rec.session.id,
    rec.runtime,
    text,
    // It is waiting for its person now: no wait for quiet.
    {
      quietMs: 0,
      maxMs: 0,
      onDialog: () => {
        dialog = true;
      },
    },
  );
  // A dialog for its person is open: its answer is theirs, in the
  // terminal; a message typed now would answer it.
  if (dialog)
    throw new AgentError(
      `${rec.id} is waiting on you in its terminal. Answer it there first.`,
      { status: 409, code: "dialog_open" },
    );
  if (!sent)
    throw new AgentError(`${rec.id} is not running. Resume it first.`, {
      status: 409,
      code: "not_running",
    });
}

/** The route: read and check the body, then type it. The text sent. */
export async function sayToAgent(
  d: AgentsResolved,
  rec: AgentRecord,
  req: http.IncomingMessage,
): Promise<string> {
  const { text, pages } = await sayBody(req);
  const message = composeMessage(text, pages);
  await typeMessage(d, rec, message);
  return message;
}
