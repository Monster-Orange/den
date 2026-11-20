/**
 * Issue 629's live check, run as the bed runs it (runLikeBed) on a fake
 * bed: a Den that holds its note after a restart while the server agent
 * shows a dialog for its person, and refuses a message from the page with
 * 409 dialog_open, passes; a Den that types the note once its wait runs
 * out, and types the message, fails; a restart held for an Allow fails
 * clause 1 (never skipped). The Hub clauses skip with their reason.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

type Kind = "fixed" | "unfixed" | "held-for-allow";

function runGate(
  kind: Kind,
  serverWas: "stopped" | "running" = "stopped",
  hub = false,
) {
  const js = `
    const g = await import("./gate/629.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const kind = ${JSON.stringify(kind)};
    // The bed's server agent, as the bed had it before the check.
    const states = { server: ${JSON.stringify(serverWas)}, "gate-629-say": null, "gate-629-hub": null };
    const withHub = ${JSON.stringify(hub)};
    // Hub's queued comments for an agent: Den types one once the agent is
    // free (a fixed Den), or at once (an unfixed one); by id, once.
    const hubQueue = [];
    const stops = [];
    let clock = 1_700_000_000_000;
    const now = () => clock;
    Date.now = now;
    const typed = { server: [], "gate-629-say": [], "gate-629-hub": [] };
    const dialog = { server: false, "gate-629-say": false, "gate-629-hub": false };
    const yml = { closed: false, set: null };
    let started = "2026-11-19T00:00:00.000Z";
    let selfUpdate = "ask";
    let restartAt = null, upAt = null, held = false, told = false, auditAt = null;
    const audit = [];
    const WAIT = 10_000;
    // The fake Den's back-note loop, as server-restart.ts's tellBack runs.
    function tick() {
      // As Den: the server-back row is written once tellBack returns, a
      // little after the note is typed.
      if (auditAt !== null && clock >= auditAt) {
        audit.push('{"verb":"server-back","detail":"on x: y; agent:server told"}');
        auditAt = null;
      }
      if (restartAt !== null && upAt === null && clock >= restartAt + 2000) {
        upAt = clock; started = new Date(clock).toISOString();
      }
      for (const c of hubQueue) {
        if (c.done || clock < c.at + 2000) continue;
        if (kind === "unfixed" || !dialog[c.agent]) {
          typed[c.agent].push({ t: clock, text: "Hub comment: " + c.text, enter: true });
          c.done = true;
        }
      }
      if (upAt === null || told) return;
      const past = clock >= upAt + WAIT;
      if (kind === "unfixed" ? past : !dialog.server && past) {
        typed.server.push({ t: clock, text: "Den is back", enter: true });
        told = true; held = false; auditAt = clock + 2000;
      } else if (kind !== "unfixed" && dialog.server && past) held = true;
    }
    const bell = () => {
      tick();
      // As Den's /api/notifications: a "service" item (the held note) is
      // under updates, never in groups.
      const subjects = [], service = [];
      if (held) service.push({ subject: "record:den-back-note-held", items: [{ kind: "service" }] });
      if (dialog.server) subjects.push({ subject: "agent:server", items: [{ kind: "waiting" }] });
      return {
        groups: [{ subjects }],
        updates: { count: service.length, groups: [{ subjects: service }] },
        waiting: dialog.server ? [{ agent: "server" }] : [],
      };
    };
    const agent = (id) => ({
      start() { states[id] = "running"; return { code: 0 }; },
      async running() { states[id] = "running"; return 300; },
      state() { return states[id]; },
      stop() { stops.push(id); states[id] = "stopped"; return { code: 0 }; },
      remove() {},
      permissionRequest() { dialog[id] = true; },
      print(t) { if (/\\[2J/.test(t)) dialog[id] = false; },
      async typed({ since }) {
        tick();
        const s = typeof since === "number" ? since : Date.parse(since);
        return typed[id].filter((x) => x.t >= s);
      },
      async mcp(tool) {
        if (tool === "den_restart_server" && selfUpdate === "auto" && kind !== "held-for-allow")
          restartAt = clock;
        return { ok: true };
      },
    });
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep(ms) { clock += ms; tick(); },
      async until(fn, ms) {
        const end = clock + ms;
        for (;;) { if (await fn()) return 0; if (clock >= end) return null; clock += 500; tick(); }
      },
      userYml(o) { yml.set = o; return { close() { yml.closed = true; } }; },
      stubLog() { return []; },
      cli() { return { code: 0, out: "", err: "" }; },
      readBed(rel) {
        if (rel === "state:agents/gate-629-say.json") return JSON.stringify({ workspace: "gate-ws", runtime: "den-claude" });
        if (rel === "state:agents/server.json") return JSON.stringify({ workspace: "den-server", runtime: "den-claude" });
        if (rel === "state:audit.jsonl") return audit.join("\\n");
        return null;
      },
      async api(p, init) {
        if (p === "/api/notifications") return bell();
        if (p === "/api/server-info") { tick(); return { startedAt: started, restartWaitSeconds: 10 }; }
        if (p === "/api/settings") {
          if (init?.method === "POST") selfUpdate = JSON.parse(init.body).server_agent_self_update ?? "ask";
          return { server_agent_self_update: selfUpdate };
        }
        return {};
      },
      async fetch(p, init) {
        if (p === "/api/settings") { await ctx.api(p, init); return { status: 200, body: "{}" }; }
        if (/\\/agents\\/gate-629-say\\/say$/.test(p)) {
          if (kind !== "unfixed" && dialog["gate-629-say"])
            return { status: 409, body: JSON.stringify({ ok: false, code: "dialog_open", error: "waiting on you" }) };
          typed["gate-629-say"].push({ t: clock, text: JSON.parse(init.body).text, enter: true });
          audit.push('{"verb":"agents","detail":"send gate-629-say a message in gate-ws (40 characters)"}');
          return { status: 200, body: JSON.stringify({ ok: true }) };
        }
        return { status: 404, body: "{}" };
      },
    };
    ctx.agent = agent;
    if (withHub)
      ctx.hub = {
        async comment({ agent: a, text, workspace }) {
          if (workspace !== "proj-gate") throw new Error("not linked");
          hubQueue.push({ agent: a, text, at: clock, done: false });
          return { id: "c" + hubQueue.length };
        },
        async delivery() { return null; },
      };
    const out = await runLikeBed("629.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out, yml, selfUpdate, serverAfter: states.server, stops }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: {
      clause: string;
      ok: boolean | null;
      skip?: string;
      detail?: string;
    }[];
    error?: string;
    yml: { closed: boolean; set: unknown };
    selfUpdate: string;
    serverAfter: string | null;
    stops: string[];
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/629.mjs as the bed runs it", () => {
  it("a Den that holds its note and refuses the message passes clauses 1 and 4", () => {
    const r = runGate("fixed");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(true);
    expect(row(r, 3)?.ok).toBe(true);
  });

  it("a Den that types into the dialog fails clauses 1 and 4", () => {
    const r = runGate("unfixed");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(false);
    expect(row(r, 3)?.ok).toBe(false);
  });

  it("a restart held for an Allow fails clause 1, never skips it", () => {
    const r = runGate("held-for-allow");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(false);
    expect(row(r, 0)?.skip).toBeUndefined();
    expect(row(r, 0)?.detail).toMatch(/Allow/);
  });

  it("with Hub, a comment for an agent showing a dialog waits, then is typed once (clause 2)", () => {
    const r = runGate("fixed", "stopped", true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(true);
  });

  it("with Hub, a Den that types the comment into the dialog fails clause 2", () => {
    const r = runGate("unfixed", "stopped", true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(false);
  });

  it("the Hub clauses skip with their reason when the bed has no Hub", () => {
    const r = runGate("fixed");
    for (const i of [1, 2]) {
      expect(row(r, i)?.ok).toBeNull();
      expect(row(r, i)?.skip).toBe("needs-hub");
    }
  });

  it("puts back the restart wait and the self-update setting", () => {
    const r = runGate("fixed");
    expect(r.yml.set).toEqual({ ui: { restart_wait_seconds: 10 } });
    expect(r.yml.closed).toBe(true);
    expect(r.selfUpdate).toBe("ask");
  });

  it("leaves the bed's server agent as it found it: stopped stays stopped", () => {
    const r = runGate("fixed", "stopped");
    expect(r.serverAfter).toBe("stopped");
    expect(r.stops).toContain("server");
  });

  it("leaves the bed's server agent as it found it: running stays running", () => {
    const r = runGate("fixed", "running");
    expect(r.serverAfter).toBe("running");
    expect(r.stops).not.toContain("server");
  });
});
