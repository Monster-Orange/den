/**
 * `<cli> approvals withdraw <id>` and `<cli> approvals list
 * --mine`, a held write the caller asked for and that still waits. They use
 * the approval routes on this install's web server, as whoever runs them:
 * inside an agent's session, that agent (its token); otherwise the person.
 * The route lets only the asker withdraw, so a person can't
 * withdraw an agent's request here: they Deny it.
 *
 * Scriptable (a gate's live check cleans up with it): withdraw exits 0
 * when the request is withdrawn or had already ended (decided, expired, lost
 * at a restart), 1 with the reason when it isn't the caller's, isn't known,
 * or Den didn't answer, 2 on a usage error.
 */
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { product } from "../../shared/product.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { denWebBase } from "../../shared/web-dial.js";

export const APPROVALS_HELP = {
  usage: "approvals withdraw <id> | approvals list --mine",
  lines: [
    "Your own requests that wait for a person's Allow.",
    "  withdraw <id>  take back one you asked; nothing runs (exit 0 if it already ended)",
    "  list --mine    the ones you asked that still wait",
  ],
};

/** A request id as the routes take it. */
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
/** A withdraw refused because the request had already ended: done for a script. */
const ENDED = new Set(["already_decided", "expired", "lost"]);

export interface ApprovalsIo {
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

const stdIo: ApprovalsIo = {
  out: (s) => void process.stdout.write(`${s}\n`),
  err: (s) => void process.stderr.write(`${s}\n`),
  api: httpApi,
};

const reasonOf = (r: { status: number; data: Record<string, unknown> }) =>
  typeof r.data.error === "string" ? r.data.error : `HTTP ${r.status}`;

export async function cmdApprovals(
  args: readonly string[],
  io: ApprovalsIo = stdIo,
): Promise<number> {
  const cli = product().cli;
  const usage = () => {
    io.err(`usage: ${cli} ${APPROVALS_HELP.usage}`);
    for (const l of APPROVALS_HELP.lines) io.err(l);
    return 2;
  };
  const call = async (
    what: string,
    method: "GET" | "POST",
    p: string,
    body?: unknown,
  ) => {
    try {
      return await io.api(method, p, body);
    } catch (e) {
      io.err(
        `${cli} approvals ${what}: this install's ${product().title} didn't answer (${(e as Error).message}).`,
      );
      return null;
    }
  };

  if (args[0] === "withdraw") {
    const id = args[1] ?? "";
    if (args.length !== 2 || !ID_RE.test(id)) return usage();
    const r = await call(
      "withdraw",
      "POST",
      `/api/approvals/${id}/withdraw`,
      {},
    );
    if (!r) return 1;
    if (r.status === 200 && r.data.ok === true) {
      io.out(`Withdrawn: ${id}. Nothing ran.`);
      return 0;
    }
    if (typeof r.data.code === "string" && ENDED.has(r.data.code)) {
      io.out(`Already ended: ${reasonOf(r)}`);
      return 0;
    }
    io.err(`${cli} approvals withdraw: ${reasonOf(r)}`);
    return 1;
  }

  if (args[0] === "list") {
    if (args.length !== 2 || args[1] !== "--mine") return usage();
    const r = await call("list", "GET", "/api/approvals?mine=1");
    if (!r) return 1;
    if (r.status !== 200 || r.data.ok !== true || !Array.isArray(r.data.mine)) {
      io.err(`${cli} approvals list: ${reasonOf(r)}`);
      return 1;
    }
    const waiting = (r.data.mine as Record<string, unknown>[]).filter(
      (a) => a.state === "pending",
    );
    if (waiting.length === 0) {
      io.out("No waiting requests of yours.");
      return 0;
    }
    for (const a of waiting) {
      const claim =
        typeof a.claimedAs === "string"
          ? ` (you asked, as ${a.claimedAs}; not verified)`
          : "";
      io.out(
        `${String(a.id)}  ${String(a.action)}: ${String(a.summary)}${claim}`,
      );
    }
    return 0;
  }

  return usage();
}
