/**
 * D41: before an agent stops, ask Hub (GET <hub>/api/inbox) how many open
 * threads wait on it (`yours`). When that went up since the last time this
 * agent was told, block the stop once: "N Hub comments wait on you: call
 * hub_inbox". Answered threads drop out of `yours`, so a new reply brings
 * the nudge back.
 *
 * D52: it asks through Den's proxy (`<den>/hub`), with the agent's own Den
 * token from its session's env (DEN_ACTOR_TOKEN); Den attaches the install's
 * Hub token, which the agent never holds. Two seconds at most; any failure
 * lets the agent stop (fails open).
 */
import * as fs from "fs";
import * as path from "path";
import { actorTokenOf } from "../../actor-token.js";

export interface InboxArgs {
  /** Den's proxy to Hub (`<den>/hub`). */
  base: string;
  /** The agent's files dir: where the last nudged count is kept. */
  files: string;
}

/** `--hub-inbox <base>` (with `--files <dir>`), or null. */
export function inboxArgs(argv: readonly string[]): InboxArgs | null {
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
  };
  const base = val("--hub-inbox");
  const files = val("--files");
  return base && files ? { base, files } : null;
}

/** The agent's own Den token (its session's env), as a bearer; or null. */
function denBearer(
  env: Record<string, string | undefined>,
): Record<string, string> | null {
  const t = actorTokenOf(env);
  return t && /^[\x21-\x7e]+$/.test(t)
    ? { Authorization: `Bearer ${t}` }
    : null;
}

const stateFile = (files: string) => path.join(files, "hub-inbox.json");

function lastNudged(files: string): number {
  try {
    const n = (
      JSON.parse(fs.readFileSync(stateFile(files), "utf-8")) as {
        yours?: unknown;
      }
    ).yours;
    return typeof n === "number" && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveNudged(files: string, yours: number): void {
  try {
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(stateFile(files), `${JSON.stringify({ yours })}\n`, {
      mode: 0o600,
    });
  } catch {
    /* a count that can't be kept just nudges again */
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The Stop hook's output for the inbox check ("" lets the agent stop). */
export async function inboxBlock(
  a: InboxArgs,
  opts: {
    fetch?: FetchFn;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<string> {
  const headers = denBearer(opts.env ?? process.env);
  if (!headers) return "";
  let yours: number;
  try {
    const r = await (opts.fetch ?? fetch)(
      `${a.base.replace(/\/+$/, "")}/api/inbox`,
      {
        method: "GET",
        headers: { ...headers, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      },
    );
    if (!r.ok) return "";
    const b = (await r.json()) as { yours?: unknown };
    if (typeof b.yours !== "number" || !Number.isInteger(b.yours)) return "";
    yours = Math.max(0, Math.min(b.yours, 1_000_000));
  } catch {
    return "";
  }
  const last = lastNudged(a.files);
  if (yours <= last) {
    if (yours < last) saveNudged(a.files, yours);
    return "";
  }
  saveNudged(a.files, yours);
  return JSON.stringify({
    decision: "block",
    reason:
      yours === 1
        ? "1 Hub comment waits on you: call hub_inbox, answer it (hub_comment) or say why not, then finish."
        : `${yours} Hub comments wait on you: call hub_inbox, answer them (hub_comment) or say why not, then finish.`,
  });
}
