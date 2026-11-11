/**
 * D41: before an agent stops, ask Hub (GET <hub>/api/inbox) how many open
 * threads wait on it (`yours`). When that went up since the last time this
 * agent was told, block the stop once: "N Hub comments wait on you: call
 * hub_inbox". Answered threads drop out of `yours`, so a new reply brings
 * the nudge back.
 *
 * The install token is read from the agent's own MCP config file (the Hub
 * server's Authorization header), never from argv, env or a log. Two
 * seconds at most; any failure lets the agent stop (fails open).
 */
import * as fs from "fs";
import * as path from "path";

export interface InboxArgs {
  /** Hub's base URL (hub.url). */
  base: string;
  /** The agent's MCP config file (mcp.json), holding Hub's headers. */
  mcp: string;
  /** The agent's files dir: where the last nudged count is kept. */
  files: string;
}

/** `--hub-inbox <base> --mcp <file>` (with `--files <dir>`), or null. */
export function inboxArgs(argv: readonly string[]): InboxArgs | null {
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
  };
  const base = val("--hub-inbox");
  const mcp = val("--mcp");
  const files = val("--files");
  return base && mcp && files ? { base, mcp, files } : null;
}

/** Hub's headers from the MCP config: the server whose URL is on Hub. */
function hubHeaders(
  mcpFile: string,
  base: string,
): Record<string, string> | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpFile, "utf-8")) as {
      mcpServers?: Record<string, { url?: unknown; headers?: unknown }>;
    };
    const origin = new URL(base).origin;
    for (const s of Object.values(cfg.mcpServers ?? {})) {
      if (typeof s?.url !== "string") continue;
      if (new URL(s.url).origin !== origin) continue;
      const h = s.headers as Record<string, unknown> | undefined;
      if (!h || typeof h.Authorization !== "string") return null;
      const out: Record<string, string> = { Authorization: h.Authorization };
      if (typeof h["X-Den-Agent-Id"] === "string")
        out["X-Den-Agent-Id"] = h["X-Den-Agent-Id"];
      return out;
    }
  } catch {
    /* no file, no Hub server: nothing to ask */
  }
  return null;
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
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<string> {
  const headers = hubHeaders(a.mcp, a.base);
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
