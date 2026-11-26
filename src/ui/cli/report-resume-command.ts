/**
 * Issue 785: `<cli> agents report-resume <conversation> [--cwd <dir>]
 * [--seq <n>] [--json]`. A runtime's hook runs it inside an agent Den
 * started, to say which conversation Den resumes after a restart.
 *
 * It sends only { conversation, cwd, seq } to POST
 * /api/agents/self/resume-command, with the agent's own Den token
 * (DEN_ACTOR_TOKEN), and only to this Den (den#182). Den builds the
 * resume command itself from the runtime's template: nothing here names
 * a binary or a flag. The id is checked first, so one that reads as a
 * flag is never sent. The sequence defaults to the time in milliseconds,
 * so each report outranks the one before.
 */
import * as path from "path";
import { actorTokenOf } from "../../shared/actor-token.js";
import {
  CONVERSATION_ID,
  RESUME_REPORT_PATH,
  resumeReportProblem,
} from "../../shared/agents/resume-command.js";
import { product } from "../../shared/product.js";
import type { ServerIdentity } from "./server-identity.js";
import { defaultDenBase, thisDen } from "./this-den.js";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ReportResumeDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The folder reported when --cwd is not given (default process.cwd). */
  cwd?: () => string;
  /** The sequence when --seq is not given (default Date.now). */
  now?: () => number;
  /** Den's web server as this agent reaches it. */
  denBase?: () => string;
  /** Whose server answers at the base (den#182). */
  identify?: (base: string) => Promise<ServerIdentity>;
  fetch?: Fetch;
}

export const REPORT_RESUME_USAGE =
  "agents report-resume <conversation> [--cwd <dir>] [--seq <n>] [--json] | --notify-json <json>";

export async function cmdReportResume(
  args: readonly string[],
  deps: ReportResumeDeps = {},
): Promise<number> {
  const cli = product().cli;
  const what = `${cli} agents report-resume`;
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const usage = (why?: string) => {
    if (why) err(`${what}: ${why}`);
    err(`usage: ${cli} ${REPORT_RESUME_USAGE}`);
    return 2;
  };

  let conversation: string | undefined;
  let cwd: string | undefined;
  let seqText: string | undefined;
  let json = false;
  let notify: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--notify-json") {
      notify = args[++i];
      if (notify === undefined) return usage("--notify-json needs the JSON");
    } else if (a === "--cwd") cwd = args[++i];
    else if (a === "--seq") seqText = args[++i];
    else if (a.startsWith("-")) return usage(`unknown option ${oneWord(a)}`);
    else if (conversation !== undefined) return usage("one conversation only");
    else conversation = a;
  }
  if (notify !== undefined) {
    if (conversation !== undefined || cwd !== undefined)
      return usage("--notify-json takes the id and folder from the JSON");
    const turn = notifyTurn(notify);
    if (turn === "other") return 0;
    if (typeof turn === "string") return usage(turn);
    conversation = turn.conversation;
    cwd = turn.cwd;
  }
  if (conversation === undefined)
    return usage("the conversation id is missing");
  if (!CONVERSATION_ID.test(conversation))
    return usage(
      "a conversation id is a letter or digit, then letters, digits and . _ : - (128 at most)",
    );
  if (cwd !== undefined && !cwd) return usage("--cwd needs a folder");
  let seq: number;
  if (seqText === undefined) seq = (deps.now ?? Date.now)();
  else {
    if (!/^[0-9]+$/.test(seqText))
      return usage("--seq is a whole number above 0");
    seq = Number(seqText);
  }
  const report = {
    conversation,
    cwd: cwd ?? (deps.cwd ?? process.cwd)(),
    seq,
  };
  const problem = resumeReportProblem(report);
  if (problem) return usage(problem);

  const token = actorTokenOf(env);
  if (!token) {
    err(
      `${what} runs inside an agent Den started: it reports that agent's conversation, with its own Den token.`,
    );
    return 2;
  }
  const base = (deps.denBase ?? defaultDenBase)();
  if (!(await thisDen(what, base, deps.identify, err))) return 1;

  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}${RESUME_REPORT_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(report),
    });
  } catch (e) {
    err(`${what}: Den didn't answer at ${base}: ${(e as Error).message}`);
    return 1;
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no JSON: the status says enough */
  }
  if (!res.ok || body.ok !== true) {
    const why =
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    err(`${what}: Den refused the report: ${why}`);
    return 1;
  }
  if (json) out(JSON.stringify(body));
  else if (body.kept === true)
    out(`✓ Den will resume conversation ${conversation} after a restart.`);
  else
    out(
      `Den already holds a newer report (sequence ${String(body.seq)}); this one was not kept.`,
    );
  return 0;
}

/**
 * A notify program's JSON argument (Codex's legacy notify: type
 * "agent-turn-complete", "thread-id", "cwd"): only the thread id and the
 * folder are read. "other": another kind of notice, nothing to report.
 * A string: why it can't be read.
 */
function notifyTurn(
  text: string,
): { conversation: string; cwd: string } | "other" | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "--notify-json: not JSON";
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return "--notify-json: not a JSON object";
  const o = v as Record<string, unknown>;
  if (o.type !== "agent-turn-complete") return "other";
  const id = o["thread-id"];
  if (typeof id !== "string" || !CONVERSATION_ID.test(id))
    return "--notify-json: its thread-id is not a conversation id";
  if (typeof o.cwd !== "string" || !path.isAbsolute(o.cwd))
    return "--notify-json: its cwd is not an absolute path";
  return { conversation: id, cwd: o.cwd };
}

/** An option named back, cleaned and short. */
function oneWord(a: string): string {
  const clean = a.replace(/[^A-Za-z0-9_-]/g, "");
  return clean.slice(0, 32) || "option";
}
