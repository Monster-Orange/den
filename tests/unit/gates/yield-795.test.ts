/**
 * Issue 795: `gate yield <my-id> --to <their-id>` (and the MCP tool
 * gate_slot_yield). The owner of a waiting entry lets another waiting entry
 * move to just ahead of it, and otherwise keeps its own place: A, B, C
 * becomes C, A, B. Only the owner may; a granted slot is never touched; the
 * slot log records "yielded" with both ids; `gate status` and the queue
 * view show it on the entry's line until it starts.
 * The store lives in a temp dir; no Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type GateEntry } from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate795-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T06:00:00Z");

/** A store with a holder and three waiters A, B, C, asked a minute apart. */
function queue(o: { actorA?: string } = {}) {
  let clock = T0;
  const store = new GateStore({
    dir: tmp(),
    alive: () => true,
    now: () => clock,
  });
  const ask = (label: string, actor?: string) => {
    clock += 60_000;
    return store.ask({
      kind: "browser",
      who: label,
      label,
      pid: 1,
      estimateMin: 10,
      ...(actor ? { agent: true, actor } : {}),
    });
  };
  const h = ask("h");
  const a = ask("a", o.actorA);
  const b = ask("b");
  const c = ask("c");
  return {
    store,
    h,
    a,
    b,
    c,
    tick: (min: number) => (clock += min * 60_000),
    now: () => clock,
  };
}

const waiting = (store: GateStore) =>
  store
    .list()
    .filter((e: GateEntry) => !e.grantedAt)
    .map((e) => e.label);

function deps(store: GateStore, env: NodeJS.ProcessEnv = {}, now = Date.now) {
  const out: string[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/tmp/repo",
  };
  return { d, out, err };
}

const api = {
  baseUrl: "http://localhost:47003",
  async get(p: string) {
    if (p === "/api/workspaces")
      return { active: ["north"], workspaces: { north: {} } };
    throw new Error(`no API call expected: ${p}`);
  },
} as unknown as DenApi;
const ctx = (store: GateStore, actor = "agent:coder"): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  } as unknown as ToolContext["cfg"],
  cli: "acme",
  scope: { workspace: "north", actor },
  gates: store,
});

describe("clause 1: A yields to C", () => {
  it("A, B, C becomes C, A, B, and the slot log says yielded with both ids", async () => {
    const q = queue();
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
    const { d, out } = deps(q.store);
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], d)).toBe(0);
    expect(out.join("\n")).toContain(q.c.id);
    expect(waiting(q.store)).toEqual(["c", "a", "b"]);
    const row = q.store.events().find((e) => e.event === "yielded");
    expect(row).toMatchObject({ id: q.a.id, to: q.c.id });
    // When the holder ends, C starts first.
    q.store.release(q.h.id);
    expect(q.store.get(q.c.id)?.grantedAt).toBeTruthy();
    expect(q.store.get(q.a.id)?.grantedAt).toBeFalsy();
  });

  it("the MCP tool does the same for the agent's own entry", async () => {
    const q = queue({ actorA: "agent:coder" });
    const r = await callTool(
      "gate_slot_yield",
      { id: q.a.id, to: q.c.id },
      ctx(q.store),
    );
    expect(r.isError).toBeFalsy();
    expect(waiting(q.store)).toEqual(["c", "a", "b"]);
  });

  it("an agent yields its own entry from its shell", async () => {
    const q = queue({ actorA: "agent:coder" });
    const { d } = deps(q.store, { DEN_AGENT: "agent:coder" });
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], d)).toBe(0);
    expect(waiting(q.store)).toEqual(["c", "a", "b"]);
  });
});

describe("clause 2: only A's owner may yield", () => {
  it("another agent is refused, and nothing changes", async () => {
    const q = queue({ actorA: "agent:coder" });
    const { d, err } = deps(q.store, { DEN_AGENT: "agent:other" });
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/yours/);
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
    expect(q.store.events().some((e) => e.event === "yielded")).toBe(false);
    // Its owner may.
    const { d: mine } = deps(q.store, { DEN_AGENT: "agent:coder" });
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], mine)).toBe(0);
    expect(waiting(q.store)).toEqual(["c", "a", "b"]);
  });

  it("a person can't yield an agent's entry", async () => {
    const q = queue({ actorA: "agent:coder" });
    const { d, err } = deps(q.store);
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/yours/);
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
  });

  it("an agent can't yield a person's entry", async () => {
    const q = queue();
    const { d, err } = deps(q.store, { DEN_AGENT: "agent:coder" });
    expect(await cmdGate(["yield", q.a.id, "--to", q.c.id], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/yours/);
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
  });

  it("over MCP, another agent's entry is refused", async () => {
    const q = queue({ actorA: "agent:coder" });
    const r = await callTool(
      "gate_slot_yield",
      { id: q.a.id, to: q.c.id },
      ctx(q.store, "agent:other"),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/yours/);
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
    expect(q.store.events().some((e) => e.event === "yielded")).toBe(false);
  });
});

describe("clause 3: never a granted slot; --to names a waiting entry", () => {
  it("a holder can't yield, nor be yielded to; a gone or own id is refused", async () => {
    const q = queue();
    const { d } = deps(q.store);
    // The holder yields: refused.
    expect(await cmdGate(["yield", q.h.id, "--to", q.c.id], d)).not.toBe(0);
    // --to the holder: refused.
    expect(await cmdGate(["yield", q.a.id, "--to", q.h.id], d)).not.toBe(0);
    // --to no such entry, or itself: refused.
    expect(
      await cmdGate(["yield", q.a.id, "--to", "browser-0000000000"], d),
    ).not.toBe(0);
    expect(await cmdGate(["yield", q.a.id, "--to", q.a.id], d)).not.toBe(0);
    // --to is needed.
    expect(await cmdGate(["yield", q.a.id], d)).toBe(2);
    expect(q.store.get(q.h.id)?.grantedAt).toBeTruthy();
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
    expect(q.store.events().some((e) => e.event === "yielded")).toBe(false);
    // A waiting entry to another waiting entry behind it: yes.
    expect(await cmdGate(["yield", q.a.id, "--to", q.b.id], d)).toBe(0);
    expect(waiting(q.store)).toEqual(["b", "a", "c"]);
    expect(q.store.get(q.h.id)?.grantedAt).toBeTruthy();
  });

  it("a yield to an entry already ahead is refused (it would only push it back)", async () => {
    const q = queue();
    const { d: d2, err } = deps(q.store);
    expect(await cmdGate(["yield", q.c.id, "--to", q.a.id], d2)).not.toBe(0);
    expect(err.join("\n")).toMatch(/already ahead/);
    expect(waiting(q.store)).toEqual(["a", "b", "c"]);
  });
});

describe("clause 4: gate status shows the yield until the entry starts", () => {
  it("in the text line and --json, then not once it starts", async () => {
    const q = queue();
    const { d } = deps(q.store, {}, q.now);
    await cmdGate(["yield", q.a.id, "--to", q.c.id], d);
    const { d: d2, out } = deps(q.store, {}, q.now);
    expect(await cmdGate(["status"], d2)).toBe(0);
    const lineA = out.find((l) => l.startsWith(q.a.id))!;
    expect(lineA).toContain(`let ${q.c.id} go ahead`);
    const v = gateView(q.store, q.now());
    expect(v.slots.find((s) => s.id === q.a.id)?.yieldedTo).toEqual([q.c.id]);
    // C, then A start: A's line no longer speaks of the yield.
    q.store.release(q.h.id); // C holds
    q.store.release(q.c.id); // A holds
    expect(q.store.get(q.a.id)?.grantedAt).toBeTruthy();
    const { d: d3, out: out3 } = deps(q.store, {}, q.now);
    await cmdGate(["status"], d3);
    expect(out3.find((l) => l.startsWith(q.a.id))).not.toContain("go ahead");
    expect(
      gateView(q.store, q.now()).slots.find((s) => s.id === q.a.id)?.yieldedTo,
    ).toBeUndefined();
  });

  it("the queue view's words are in en, es and ja", () => {
    const pub = path.join(__dirname, "../../../src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect(fs.readFileSync(path.join(pub, f), "utf-8")).toMatch(
        /"gate\.yielded":\s*\n?\s*"[^"]*\{to\}/,
      );
    expect(fs.readFileSync(path.join(pub, "gate-chip.js"), "utf-8")).toContain(
      "gate.yielded",
    );
  });
});
