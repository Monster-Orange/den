/**
 * Issue 1008: `<cli> ask withdraw <id> --reason "…"`, withdraw a question
 * asked with ask_human once it is settled another way. It uses the bell's
 * own route on this install's web server (POST /api/notifications/withdraw),
 * as whoever runs it: inside an agent's session, that agent (its token);
 * otherwise the person. The server lets only the agent that asked, or the
 * person, withdraw it, and records a refused one.
 */
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { product } from "../../shared/product.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { denWebBase } from "../../shared/web-dial.js";

export const ASK_HELP = {
  usage: 'ask withdraw <id> --reason "…"',
  lines: [
    "Withdraw a question asked in the bell, once it is settled elsewhere.",
    '  withdraw <id> --reason "…"  it leaves Needs you; the bell says "settled: <reason>"',
  ],
};

export interface AskIo {
  out: (s: string) => void;
  err: (s: string) => void;
  api: (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
}

async function httpApi(
  method: "GET" | "POST",
  p: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  const r = await fetch(`${denWebBase(port)}${p}`, {
    method,
    headers: { "content-type": "application/json", ...cliAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, data };
}

const stdIo: AskIo = {
  out: (s) => void process.stdout.write(`${s}\n`),
  err: (s) => void process.stderr.write(`${s}\n`),
  api: httpApi,
};

export async function cmdAsk(
  args: readonly string[],
  io: AskIo = stdIo,
): Promise<number> {
  const cli = product().cli;
  const usage = () => {
    io.err(`usage: ${cli} ${ASK_HELP.usage}`);
    for (const l of ASK_HELP.lines) io.err(l);
    return 2;
  };
  if (args[0] !== "withdraw") return usage();
  let id = "";
  let reason = "";
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--reason") reason = args[++i] ?? "";
    else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length);
    else if (!id && !a.startsWith("-")) id = a;
    else return usage();
  }
  reason = reason.replace(/\s+/g, " ").trim();
  if (!id.trim() || !reason) return usage();
  let r: { status: number; data: Record<string, unknown> };
  try {
    r = await io.api("POST", "/api/notifications/withdraw", {
      id: id.trim(),
      reason,
    });
  } catch (e) {
    io.err(
      `${cli} ask withdraw: this install's ${product().title} didn't answer (${(e as Error).message}).`,
    );
    return 1;
  }
  if (r.status !== 200 || r.data.ok !== true) {
    const why =
      typeof r.data.error === "string" ? r.data.error : `HTTP ${r.status}`;
    io.err(`${cli} ask withdraw: ${why}`);
    return 1;
  }
  io.out(`Withdrawn: it left Needs you; the bell says "settled: ${reason}".`);
  return 0;
}
