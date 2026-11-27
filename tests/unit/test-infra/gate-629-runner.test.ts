/**
 * Issue 629's live check, run as the bed runs it (runLikeBed) on a fake
 * bed: a Den that holds its note after a restart while the server agent
 * shows a dialog for its person, and refuses a message from the page with
 * 409 dialog_open, passes; a Den that types the note once its wait runs
 * out, and types the message, fails; a restart held for the person's Allow
 * is not run (skip person). The Hub clauses skip with their reason.
 *
 * Clause 2's fake Den holds a Hub comment on its hook-set waiting mark,
 * as Den does: the screen clearing doesn't clear it; a hook a real agent
 * sends once its dialog is answered (a tool ran) does.
 *
 * A stub mid-turn draws no dialog for permissionRequest (no hook runs):
 * clauses 2 and 4 then are not run, with the reason, never a FAIL. The
 * Hub stub is named anew each run, so an earlier run's held comment can't
 * reach it.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

type Kind =
  | "fixed"
  | "unfixed"
  | "held-for-allow"
  | "fixture-say"
  | "unmarked-say"
  | "marked-say"
  | "unread-say";

function runGate(
  kind: Kind,
  serverWas: "stopped" | "running" = "stopped",
  hub = false,
  noDialog = false,
  // Hub's list as the bed reads it today: no answer field, state held, but
  // `acked` once Den has answered (it left the unanswered list).
  hubBlind = false,
) {
  const js = `
    const g = await import("./gate/629.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const kind = ${JSON.stringify(kind)};
    // The bed's server agent, as the bed had it before the check.
    const states = { server: ${JSON.stringify(serverWas)}, "gate-629-say": null, "gate-629-hub": null };
    const withHub = ${JSON.stringify(hub)};
    // A stub mid-turn: permissionRequest draws no dialog and runs no hook.
    const noDialog = ${JSON.stringify(noDialog)};
    const hubIds = [];
    // Hub's queued comments for an agent: Den types one once the agent is
    // free (a fixed Den), or at once (an unfixed one); by id, once.
    const hubQueue = [];
    const stops = [];
    let clock = 1_700_000_000_000;
    const now = () => clock;
    Date.now = now;
    const typed = { server: [], "gate-629-say": [], "gate-629-hub": [] };
    const dialog = { server: false, "gate-629-say": false, "gate-629-hub": false };
    // Den's waiting mark, set by the permission hook: cleared only by a
    // hook that says the agent went on (attention.ts), never by its screen.
    const mark = { server: null, "gate-629-say": null, "gate-629-hub": null };
    const hooks = [];
    const yml = { closed: false, set: null };
    let started = "2026-11-19T00:00:00.000Z";
    // The person's own setting: auto lets the restart go at once; ask holds
    // it for their Allow. The check only reads it.
    let selfUpdate = kind === "held-for-allow" ? "ask" : "auto";
    let settingsPosts = 0;
    // "unread-say": the say stub's record reads once (its workspace), then not.
    let sayReads = 0;
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
        if (kind === "unfixed" || !mark[c.agent]) {
          (typed[c.agent] ??= []).push({ t: clock, text: "Hub comment: " + c.text, enter: true });
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
      // The other stubs' waiting rows: Den's hook-set mark.
      for (const [a, m] of Object.entries(mark))
        if (a !== "server" && m) subjects.push({ subject: "agent:" + a, items: [{ kind: "waiting" }] });
      return {
        groups: [{ subjects }],
        updates: { count: service.length, groups: [{ subjects: service }] },
        waiting: dialog.server ? [{ agent: "server" }] : [],
      };
    };
    const agent = (id) => (id.startsWith("gate-629-hub") && !hubIds.includes(id) && hubIds.push(id), {
      start() { states[id] = "running"; return { code: 0 }; },
      async running() { states[id] = "running"; return 300; },
      state() { return states[id]; },
      stop() { stops.push(id); states[id] = "stopped"; return { code: 0 }; },
      remove() {},
      permissionRequest() {
        if (noDialog && id !== "server") return;
        dialog[id] = true; mark[id] = clock;
      },
      hook(event, input) {
        hooks.push({ id, event, input });
        // As Den's attention hook: PostToolUse / UserPromptSubmit say
        // "resumed", Stop says "finished"; a resume within 1 s of the wait
        // is from before it.
        if (!mark[id]) return;
        if (event === "Stop" || (/^(PostToolUse|UserPromptSubmit)$/.test(event) && clock - mark[id] >= 1000))
          mark[id] = null;
      },
      print(t) { if (/\\[2J/.test(t)) dialog[id] = false; },
      async typed({ since }) {
        tick();
        const s = typeof since === "number" ? since : Date.parse(since);
        return (typed[id] ?? []).filter((x) => x.t >= s);
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
        if (rel === "state:agents/gate-629-say.json") return kind === "unread-say" && sayReads++ > 0 ? null : JSON.stringify({ workspace: "gate-ws", runtime: "den-claude", ...(kind === "marked-say" ? { testBed: true } : {}) });
        if (rel === "state:agents/server.json") return JSON.stringify({ workspace: "den-server", runtime: "den-claude" });
        if (rel === "state:audit.jsonl") return audit.join("\\n");
        return null;
      },
      async api(p, init) {
        if (p === "/api/notifications") return bell();
        if (p === "/api/server-info") { tick(); return { startedAt: started, restartWaitSeconds: 10 }; }
        if (p === "/api/settings") {
          if (init?.method === "POST") { settingsPosts++; selfUpdate = JSON.parse(init.body).server_agent_self_update ?? "ask"; }
          return { server_agent_self_update: selfUpdate };
        }
        return {};
      },
      async fetch(p, init) {
        if (p === "/api/settings") { await ctx.api(p, init); return { status: 200, body: "{}" }; }
        if (/\\/agents\\/gate-629-say\\/say$/.test(p)) {
          if (kind === "unmarked-say" || kind === "marked-say" || kind === "unread-say")
            return { status: 403, body: JSON.stringify({ ok: false, error: "only a person can send an agent a message" }) };
          if (kind === "fixture-say")
            return { status: 403, body: JSON.stringify({ ok: false, code: "fixture_scope", error: "The fixture person can only use the pages and the few writes live checks need: not this." }) };
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
          if (!hubIds.includes(a)) throw new Error("no such agent " + a);
          if (workspace !== "proj-gate") throw new Error("not linked");
          hubQueue.push({ agent: a, text, at: clock, done: false });
          return { id: "c" + hubQueue.length };
        },
        async delivery(id) {
          const c = hubQueue[Number(String(id).slice(1)) - 1];
          if (c && ${JSON.stringify(hubBlind)})
            return { state: "held", ack: null, ackedAt: null, acked: true };
          return c ? { state: c.done ? "delivered" : "held", ackedAt: null } : null;
        },
      };
    const out = await runLikeBed("629.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out, yml, selfUpdate, settingsPosts, serverAfter: states.server, stops, hooks, hubIds, comments: hubQueue.length }));`;
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
    settingsPosts: number;
    serverAfter: string | null;
    stops: string[];
    hooks: { id: string; event: string; input: Record<string, unknown> }[];
    hubIds: string[];
    comments: number;
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

  it("a restart that waits for the person's Allow: clause 1 is not run (skip person), never a FAIL", () => {
    const r = runGate("held-for-allow");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)).toMatchObject({ ok: null, skip: "person" });
    expect(row(r, 0)?.detail).toMatch(/Allow/);
    expect(r.settingsPosts).toBe(0);
  });

  it("the test operator's say refused for a stub with no testBed mark (issue 956): clause 4 is not run, never a FAIL", () => {
    const r = runGate("unmarked-say");
    expect(r.error).toBeUndefined();
    expect(row(r, 3)).toMatchObject({ ok: null, skip: "needs-fixture-say" });
    expect(row(r, 3)?.detail).toMatch(
      /only a person can send an agent a message/,
    );
    expect(row(r, 3)?.detail).toMatch(/has no testBed mark/);
  });

  it("the test operator's say refused for a stub Den marked testBed: clause 4 FAILs, naming the refusal", () => {
    const r = runGate("marked-say");
    expect(r.error).toBeUndefined();
    expect(row(r, 3)?.ok).toBe(false);
    expect(row(r, 3)?.skip).toBeUndefined();
    expect(row(r, 3)?.detail).toMatch(
      /marked testBed: 403 \(no code\): only a person can send an agent a message/,
    );
  });

  it("a plain 403 when the stub's record can't be read: not run, and the detail says the mark is unknown", () => {
    const r = runGate("unread-say");
    expect(r.error).toBeUndefined();
    expect(row(r, 3)).toMatchObject({ ok: null, skip: "needs-fixture-say" });
    expect(row(r, 3)?.detail).toMatch(/testBed mark is unknown/);
  });

  it("the page's say refused to the fixture person: clause 4 is not run, never a FAIL", () => {
    const r = runGate("fixture-say");
    expect(r.error).toBeUndefined();
    expect(row(r, 3)).toMatchObject({ ok: null, skip: "needs-fixture-say" });
    expect(row(r, 0)?.ok).toBe(true);
  });

  it("with Hub, a comment for an agent showing a dialog waits, then is typed once (clause 2)", () => {
    const r = runGate("fixed", "stopped", true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(true);
  });

  it("with Hub, the stub answers its dialog as a real agent does: a resumed hook after its screen clears", () => {
    const r = runGate("fixed", "stopped", true);
    const h = r.hooks.filter((x) => x.id.startsWith("gate-629-hub"));
    expect(h).toEqual([
      { id: r.hubIds[0], event: "PostToolUse", input: { tool_name: "Bash" } },
    ]);
  });

  it("Hub's list without the answer field: a fixed Den passes clause 2 on Den's side", () => {
    const r = runGate("fixed", "stopped", true, false, true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(true);
  });

  it("Hub's list without the answer field: a Den that types into the dialog still fails clause 2", () => {
    const r = runGate("unfixed", "stopped", true, false, true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(false);
  });

  it("with Hub, a Den that types the comment into the dialog fails clause 2", () => {
    const r = runGate("unfixed", "stopped", true);
    expect(r.error).toBeUndefined();
    expect(row(r, 1)?.ok).toBe(false);
  });

  it("a stub that draws no dialog (mid-turn): clauses 2 and 4 are not run, with the reason, never FAIL", () => {
    const r = runGate("fixed", "stopped", true, true);
    expect(r.error).toBeUndefined();
    for (const i of [1, 3]) {
      expect(row(r, i)?.ok).toBeNull();
      expect(row(r, i)?.skip).toBe("needs-dialog");
      expect(row(r, i)?.detail).toMatch(/the dialog never came up/);
    }
    // Nothing is posted to an agent with no dialog up.
    expect(r.comments).toBe(0);
  });

  it("the Hub stub is named anew each run", () => {
    const a = runGate("fixed", "stopped", true);
    const b = runGate("fixed", "stopped", true);
    expect(a.hubIds).toHaveLength(1);
    expect(b.hubIds).toHaveLength(1);
    expect(a.hubIds[0]).toMatch(/^gate-629-hub-[a-z0-9]+$/);
    expect(a.hubIds[0]).not.toBe(b.hubIds[0]);
  });

  it("each skipped clause names its own reason: no Hub, and no tool-list change", () => {
    const r = runGate("fixed");
    expect(row(r, 1)).toMatchObject({ ok: null, skip: "needs-hub" });
    expect(row(r, 2)).toMatchObject({
      ok: null,
      skip: "needs-tool-list-change",
    });
  });

  it("puts back the restart wait, and never writes the person's self-update setting", () => {
    const r = runGate("fixed");
    expect(r.yml.set).toEqual({ ui: { restart_wait_seconds: 10 } });
    expect(r.yml.closed).toBe(true);
    expect(r.selfUpdate).toBe("auto");
    expect(r.settingsPosts).toBe(0);
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
