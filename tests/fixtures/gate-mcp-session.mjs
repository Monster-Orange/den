/**
 * Issue 1213: ctx.mcp for live checks, the reference implementation.
 *
 * The bed's harness gives a check `ctx.mcp({ agent })`: one MCP session
 * held for the check's whole run, as that stub agent, through the same
 * server Den starts for it. The harness reads the agent's own MCP config
 * (`<filesDir>/mcp.json`, Den's server entry: its command, args and env)
 * and starts it over stdio, so the session has the agent's identity and
 * project and the check never sees a token. A person-only call stays
 * refused (it runs as an agent).
 *
 *   const m = await ctx.mcp({ agent: "gate714-b-x1" });
 *   const r = await m.call("gate_slot_request", { kind: "browser" });
 *   // r: { text, isError }; one-time codes masked as in ctx.cli
 *   await m.close(); // optional: the harness closes every session at the end
 *
 * Only for an agent this check started in this run: any other id (a real
 * agent's) is refused, and the error never names it.
 *
 * The harness closes every session when the check ends, also when it
 * throws (`withMcpSessions`), so no slot outlives its check: Den takes an
 * MCP slot back once its server is gone.
 *
 * Den's runner-like harness (gate-runner-like.mjs) uses this file; the
 * bed's harness builds its own from this contract.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** One-time codes (pairing, device, sign-in) masked, as ctx.cli does. */
const CODE =
  /\b(?:[A-Z0-9]{4}-){1,3}[A-Z0-9]{4}\b|den_[a-z]+_[A-Za-z0-9_-]{16,}/g;
export const maskCodes = (s) => String(s ?? "").replace(CODE, "••••");

/**
 * Den's server entry in an agent's MCP config ({ mcpServers }): the one
 * whose args run `mcp`. Null when there is none.
 */
export function denServerOf(config) {
  const servers = Object.values(config?.mcpServers ?? {});
  return (
    servers.find(
      (s) => typeof s?.command === "string" && (s.args ?? []).includes("mcp"),
    ) ?? null
  );
}

/** Opens a session over stdio to `server` ({ command, args, env, cwd }). */
export async function openMcpSession(server, { name = "den-gate" } = {}) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...(server.env ?? {}) },
    ...(server.cwd ? { cwd: server.cwd } : {}),
    stderr: "ignore",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  let closed = false;
  return {
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args });
      const text = (r.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { text: maskCodes(text), isError: r.isError === true };
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
    },
  };
}

/** The refusal for an agent the check didn't start; it names no agent. */
export const NOT_STARTED =
  "ctx.mcp: refused: not an agent this check started in this run";

/**
 * Gives `ctx` a tracked `mcp` (from `open(opts)`, a session factory) and
 * runs `fn`; every session opened is closed afterwards, however fn ends.
 *
 * A session is only for a stub agent this check started in this run: the
 * harness wraps `ctx.agent`, records an id when its `start` succeeds, and
 * refuses any other id (a real agent's, Den's own server agent's) with
 * NOT_STARTED, which never echoes the id.
 */
export async function withMcpSessions(ctx, open, fn) {
  const open_ = [];
  const started = new Set();
  const agent = ctx.agent;
  if (typeof agent === "function")
    ctx.agent = async (name, ...rest) => {
      const ctl = await agent.call(ctx, name, ...rest);
      if (!ctl || typeof ctl.start !== "function") return ctl;
      const start = ctl.start.bind(ctl);
      ctl.start = async (...a) => {
        const r = await start(...a);
        if (!(r && typeof r.code === "number" && r.code !== 0))
          started.add(ctl.id ?? name);
        return r;
      };
      return ctl;
    };
  ctx.mcp = async (opts) => {
    if (!started.has(opts?.agent)) throw new Error(NOT_STARTED);
    const s = await open(opts);
    open_.push(s);
    return s;
  };
  try {
    return await fn();
  } finally {
    for (const s of open_) await Promise.resolve(s.close?.()).catch(() => {});
    if (typeof agent === "function") ctx.agent = agent;
  }
}
