/**
 * Issue 1213: a scripted bed for the 714 check's ctx.mcp clause. One
 * browser line, stub agents that log what Den typed, per-agent sessions;
 * an unclaimed grant passes on after two polls. Run as a script:
 *
 *   node tests/fixtures/gate714-fake-bed.mjs <scenario>
 *
 * scenarios: none (no ctx.mcp), pass, no-grant-line, throws, echo (the
 * reference session against mcp-echo-server.mjs). Prints one JSON line.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runLikeBed } from "./gate-runner-like.mjs";
import {
  denServerOf,
  openMcpSession,
  withMcpSessions,
} from "./gate-mcp-session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/** Agents already on the bed, not this check's (Den's own server agent). */
const REAL_AGENTS = new Set(["den-server"]);

function world(opts = {}) {
  const typed = {};
  const removed = [];
  const closed = [];
  let clock = 1000;
  let seq = 0;
  let line = [];
  const type = (agent, text) => (typed[agent] ??= []).push({ at: clock, text });
  const grantNext = () => {
    const next = line.find((s) => !s.granted);
    if (next && !line.some((s) => s.granted)) {
      next.granted = true;
      if (opts.typesGrant !== false)
        type(
          next.agent,
          `Den: your browser slot is granted: ${next.id}. Call gate_slot_request with this id to start; it passes to the next in line after 3 min.`,
        );
    }
  };
  const tick = () => {
    clock += 1000;
    for (const s of line)
      if (s.granted && !s.claimed && ++s.polls >= 2) {
        line = line.filter((x) => x !== s);
        line.push({ ...s, id: `browser-${++seq}`, granted: false, polls: 0 });
        type(
          s.agent,
          `Den: your browser slot ${s.id} passed to the next in line: it wasn't claimed within 3 min. You're back in line.`,
        );
        grantNext();
        return;
      }
  };
  const view = (s) => ({
    id: s.id,
    kind: "browser",
    granted: s.granted,
    who: `agent:${s.agent} · north`,
  });
  // A session closes once, as the reference does (gate-mcp-session.mjs):
  // the check's teardown and the harness may both close it.
  const mcpOpen = async ({ agent }) => {
    let done = false;
    return {
      async call(tool, args) {
        if (tool === "gate_slot_request") {
          if (opts.throwOnAsk) throw new Error("the bed went away");
          if (args.id) {
            const s = line.find((x) => x.id === args.id);
            if (s?.granted) s.claimed = true;
            return {
              text: JSON.stringify(s ? view(s) : { error: "gone" }),
              isError: false,
            };
          }
          const s = {
            id: `browser-${++seq}`,
            agent,
            granted: false,
            claimed: true,
            polls: 0,
          };
          if (line.some((x) => x.granted)) s.claimed = false;
          else s.granted = true;
          line.push(s);
          return { text: JSON.stringify(view(s)), isError: false };
        }
        if (tool === "gate_slot_release") {
          line = line.filter((x) => x.id !== args.id);
          grantNext();
          return { text: "{}", isError: false };
        }
        if (tool === "gate_slot_status")
          return {
            text: JSON.stringify({
              settings: { claimMinutes: 3 },
              slots: line.map(view),
            }),
            isError: false,
          };
        return { text: "", isError: true };
      },
      async close() {
        if (done) return;
        done = true;
        closed.push(agent);
      },
    };
  };
  const ctx = {
    log() {},
    now: () => clock,
    sleep: async () => {},
    async until(fn, ms) {
      for (let waited = 0; waited <= ms; waited += 1000) {
        if (await fn()) return waited;
        tick();
      }
      return null;
    },
    // An id that already belongs to an agent the check didn't start (a
    // real one) is refused at start, as the bed's harness does: start()
    // never takes over an existing agent.
    agent: async (name) => ({
      id: name,
      start: async () =>
        REAL_AGENTS.has(name)
          ? {
              code: 1,
              err: "refused: that id belongs to an agent this check didn't start",
            }
          : { code: 0 },
      running: async () => 1,
      idlePrompt: async () => {},
      typed: async ({ since }) =>
        (typed[name] ?? []).filter((x) => x.at >= since),
      remove: async () => void removed.push(name),
    }),
    mcpOpen,
  };
  return { ctx, removed, closed };
}

async function main(scenario) {
  if (scenario === "echo") {
    const server = denServerOf({
      mcpServers: {
        other: { command: "node", args: ["other.js"] },
        den: {
          command: process.execPath,
          args: [path.join(HERE, "mcp-echo-server.mjs"), "mcp"],
          env: { ECHO_AGENT: "gate714-b" },
        },
      },
    });
    const m = await openMcpSession(server);
    try {
      return { server: server.args, r: await m.call("echo", { say: "hello" }) };
    } finally {
      await m.close();
    }
  }
  if (scenario === "foreign") {
    // Issue 1213: a session only for an agent this check started in this
    // run. One it didn't start (a real agent, say Den's server agent) is
    // refused, and the error doesn't name it.
    const w = world();
    const out = {};
    await withMcpSessions(w.ctx, w.ctx.mcpOpen, async () => {
      try {
        await w.ctx.mcp({ agent: "den-server" });
        out.foreign = "opened";
      } catch (e) {
        out.foreign = String(e?.message ?? e);
      }
      const ctl = await w.ctx.agent("gate714-own");
      try {
        await w.ctx.mcp({ agent: "gate714-own" });
        out.beforeStart = "opened";
      } catch (e) {
        out.beforeStart = String(e?.message ?? e);
      }
      await ctl.start("tester");
      await w.ctx.mcp({ agent: "gate714-own" });
      out.own = "opened";
      // A real agent's id: the bed refuses to start it (never takes over an
      // existing agent), so its mcp.json stays out of reach.
      const real = await w.ctx.agent("den-server");
      out.realStart = (await real.start("tester"))?.code ?? null;
      try {
        await w.ctx.mcp({ agent: "den-server" });
        out.realAfterStart = "opened";
      } catch (e) {
        out.realAfterStart = String(e?.message ?? e);
      }
    });
    out.closed = w.closed;
    return out;
  }
  const mod = await import(path.join(ROOT, "gate/714.mjs"));
  if (scenario === "none")
    return runLikeBed("714.mjs", mod, { log() {}, now: () => 0 });
  const w = world({
    typesGrant: scenario !== "no-grant-line",
    throwOnAsk: scenario === "throws",
  });
  const out = await runLikeBed("714.mjs", mod, w.ctx);
  return { ...out, closed: w.closed, removed: w.removed };
}

main(process.argv[2]).then(
  (o) => console.log(JSON.stringify(o)),
  (e) => console.log(JSON.stringify({ crash: String(e?.stack || e) })),
);
