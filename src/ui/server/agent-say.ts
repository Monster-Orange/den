/**
 * Issue 103: a composer's Send. The person's message is typed into the
 * agent's session over the host's write path (as a first instruction is,
 * AG-10.1): one bracketed paste when the program turned it on, then
 * Enter. Nothing reaches the session before Send.
 *
 *   POST /api/workspaces/<ws>/agents/<id>/say   { text }   (a person only)
 *
 * The text is checked as an instruction is (checkInstruction: no control
 * character, no escape sequence, no bidi override, at most 8000
 * characters). A stopped agent, or one whose session ended: 409
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
import { readBody } from "./http-helpers.js";

/** The largest body Send takes. */
const SAY_BODY = 64 * 1024;

/** The message a POST asks to send, checked. */
export async function sayBody(req: http.IncomingMessage): Promise<string> {
  const raw = await readBody(req).catch(() => "");
  if (raw.length > SAY_BODY)
    throw new AgentError("request too large", { status: 413, usage: true });
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    throw new AgentError("invalid JSON", { usage: true });
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new AgentError("the body must be an object: { text }", {
      usage: true,
    });
  for (const k of Object.keys(v))
    if (k !== "text")
      throw new AgentError(`${k}: unknown field (say takes text)`, {
        usage: true,
      });
  const text = checkInstruction((v as { text?: unknown }).text);
  if (!text)
    throw new AgentError("write a message first", {
      usage: true,
      code: "empty",
    });
  return text;
}

/**
 * Type `text` into `rec`'s session and press Enter. Throws 409
 * not_running when it has no live session.
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
  const sent = await sendFirstInstruction(
    d,
    rec.session.id,
    rec.runtime,
    text,
    // It is waiting for its person now: no wait for quiet.
    { quietMs: 0, maxMs: 0 },
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
  const text = await sayBody(req);
  await typeMessage(d, rec, text);
  return text;
}
