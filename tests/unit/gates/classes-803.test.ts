/**
 * Issue 803: priority classes per project. Settings name the classes
 * (highest first), map each project or a label pattern to one (with a
 * default), and may give a class a window: its long runs start outside the
 * window only when no higher-class run holds or waits. Among waiters a
 * higher class goes first; within a class it is first-come; a granted slot
 * is never taken back. No classes set: exactly today's queue. The class
 * comes from settings, never from the asker, and shows in `gate status`,
 * the queue view and the slot log.
 * The store lives in a temp dir; no Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  type GateKind,
} from "../../../src/shared/gates/rules.js";
import { BOX_DEFAULTS } from "../../../src/shared/gates/boxes.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate803-"));
  tmps.push(d);
  return d;
};

/** 19:00 local time, the day the tests run on. */
const AT_19 = new Date(2026, 10, 20, 19, 0, 0).getTime();

function bed(settings: Record<string, unknown> = {}, start = AT_19) {
  let clock = start;
  const store = new GateStore({
    dir: tmp(),
    alive: () => true,
    now: () => clock,
  });
  if (Object.keys(settings).length) {
    const c = checkGatePatch(settings);
    if (!c.ok) throw new Error(c.error);
    store.writeSettings(c.patch);
  }
  const ask = (
    label: string,
    o: { project?: string; kind?: GateKind; estimateMin?: number } = {},
  ) => {
    clock += 1000;
    return store.ask({
      kind: o.kind ?? "cpu",
      who: label,
      label,
      pid: 1,
      estimateMin: o.estimateMin ?? 10,
      ...(o.project ? { project: o.project } : {}),
    });
  };
  const waiting = () =>
    store
      .list()
      .filter((e) => !e.grantedAt)
      .map((e) => e.label);
  const granted = (label: string) =>
    !!store.list().find((e) => e.label === label)?.grantedAt;
  return {
    store,
    ask,
    waiting,
    granted,
    now: () => clock,
    tick: (min: number) => (clock += min * 60_000),
  };
}

function deps(store: GateStore, now: () => number) {
  const out: string[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/tmp/rel-repo",
  };
  return { d, out, err };
}

const CLASSES = {
  cpu_slots: 1,
  class_order: "release, lane, other",
  class_map: "rel-repo=release, label:release*=release, lanes=lane, *=other",
};

describe("clause 1: a higher class goes first", () => {
  it("a release entry asked after three other entries starts before them", () => {
    const b = bed(CLASSES);
    const h = b.ask("holder", { project: "app" });
    b.ask("o1", { project: "app" });
    b.ask("o2", { project: "app" });
    b.ask("o3", { project: "app" });
    b.ask("r", { project: "rel-repo" });
    expect(b.waiting()).toEqual(["r", "o1", "o2", "o3"]);
    b.store.release(h.id);
    expect(b.granted("r")).toBe(true);
    expect(b.granted("o1")).toBe(false);
  });

  it("a label pattern maps too, and a project with no rule takes the default", () => {
    const b = bed(CLASSES);
    b.ask("holder", { project: "app" });
    b.ask("o1", { project: "somewhere" });
    b.ask("l1", { project: "lanes" });
    b.ask("release check", { project: "somewhere" });
    expect(b.waiting()).toEqual(["release check", "l1", "o1"]);
  });

  it("the class comes from settings, never from the asker", () => {
    const b = bed(CLASSES);
    b.ask("holder", { project: "app" });
    const o = b.store.ask({
      kind: "cpu",
      who: "o",
      label: "o",
      pid: 1,
      estimateMin: 10,
      project: "app",
      // An asker naming its own class is not heard.
      ...({ class: "release" } as Record<string, unknown>),
    });
    b.ask("r", { project: "rel-repo" });
    expect(b.waiting()).toEqual(["r", "o"]);
    expect(
      gateView(b.store, b.now()).slots.find((s) => s.id === o.id),
    ).toMatchObject({ class: "other" });
  });
});

describe("the default example (11-20): within P0, release before lane", () => {
  // P0 for the platform's own project, P1 for the product, P2 the rest;
  // within P0, release checks go before lane tests. The sub-order is a
  // label rule scoped to one project: "<project> label:<pattern>=<class>".
  const P = {
    cpu_slots: 1,
    class_order: "p0-release, p0, p1, p2",
    class_map:
      "platform label:release*=p0-release, platform=p0, product=p1, *=p2",
  };

  it("a P0 release starts before an earlier P0 lane entry, and both before any P1", () => {
    const b = bed(P);
    const h = b.ask("holder", { project: "other" });
    b.ask("p1 lane", { project: "product" });
    b.ask("release p1", { project: "product" }); // a P1 release stays P1
    b.ask("p0 lane", { project: "platform" });
    b.ask("release check", { project: "platform" });
    expect(b.waiting()).toEqual([
      "release check",
      "p0 lane",
      "p1 lane",
      "release p1",
    ]);
    b.store.release(h.id);
    expect(b.granted("release check")).toBe(true);
    b.store.release(b.store.list().find((e) => e.grantedAt)!.id);
    expect(b.granted("p0 lane")).toBe(true);
    expect(b.granted("p1 lane")).toBe(false);
  });

  it("the scoped rule parses, and a bad one says what is wrong", () => {
    expect(checkGatePatch({ class_map: P.class_map }).ok).toBe(true);
    const bad = checkGatePatch({ class_map: "platform label:=p0" });
    expect(bad.ok).toBe(false);
  });
});

describe("clause 2: within a class, first-come", () => {
  it("two entries of the same class keep their order", () => {
    const b = bed(CLASSES);
    b.ask("holder", { project: "app" });
    b.ask("o1", { project: "app" });
    b.ask("r1", { project: "rel-repo" });
    b.ask("o2", { project: "app" });
    b.ask("r2", { project: "rel-repo" });
    expect(b.waiting()).toEqual(["r1", "r2", "o1", "o2"]);
  });
});

describe("clause 3: no classes set, exactly today's queue", () => {
  it("first-come, no class shown, the settings line unchanged", async () => {
    const b = bed({ cpu_slots: 1 });
    b.ask("holder", { project: "app" });
    b.ask("o1", { project: "app" });
    b.ask("r", { project: "rel-repo" });
    expect(b.waiting()).toEqual(["o1", "r"]);
    expect(b.store.settings().classes).toBeUndefined();
    expect(gateView(b.store, b.now()).slots.every((s) => !("class" in s))).toBe(
      true,
    );
    const { d, out } = deps(b.store, b.now);
    await cmdGate(["status"], d);
    expect(out.join("\n")).not.toContain("class");
  });

  it("clearing the classes puts the queue back to first-come", async () => {
    const b = bed(CLASSES);
    b.ask("holder", { project: "app" });
    b.ask("o1", { project: "app" });
    b.ask("r", { project: "rel-repo" });
    expect(b.waiting()).toEqual(["r", "o1"]);
    const { d } = deps(b.store, b.now);
    expect(await cmdGate(["settings", "--class-order", ""], d)).toBe(0);
    expect(b.store.settings().classes).toBeUndefined();
    expect(b.waiting()).toEqual(["o1", "r"]);
  });

  it("the settings are today's, key for key", () => {
    expect(GATE_DEFAULTS.classes).toBeUndefined();
    // With issue 625 in the same build, the box settings join today's.
    expect(bed({ cpu_slots: 1 }).store.settings()).toEqual({
      ...GATE_DEFAULTS,
      ...BOX_DEFAULTS,
      cpuSlots: 1,
    });
  });
});

describe("clause 4: a granted slot is never taken back", () => {
  it("a release ask waits for an other holder; the holder keeps its slot", () => {
    const b = bed(CLASSES);
    const h = b.ask("holder", { project: "app" });
    b.ask("r", { project: "rel-repo" });
    expect(b.granted("holder")).toBe(true);
    expect(b.granted("r")).toBe(false);
    b.tick(120);
    expect(b.store.get(h.id)?.grantedAt).toBeTruthy();
    expect(b.granted("r")).toBe(false);
    expect(b.store.events().some((e) => e.event.startsWith("taken-back"))).toBe(
      false,
    );
  });
});

describe("clause 5: windows", () => {
  const WINDOWED = {
    cpu_slots: 3,
    class_order: "release, other",
    class_map: "rel-repo=release, *=other",
    class_windows: "other=22:00-06:00/30",
  };

  it("a long other run at 19:00 waits until 22:00 while a release run is in the queue", async () => {
    const b = bed(WINDOWED);
    b.ask("r", { project: "rel-repo", estimateMin: 600 });
    expect(b.granted("r")).toBe(true);
    b.ask("long", { project: "app", estimateMin: 60 });
    b.ask("short", { project: "app", estimateMin: 10 });
    // The short run is not windowed; the long one waits, and blocks no one.
    expect(b.granted("short")).toBe(true);
    expect(b.granted("long")).toBe(false);
    const { d, out } = deps(b.store, b.now);
    await cmdGate(["status"], d);
    expect(out.find((l) => l.includes('"long"'))).toContain("22:00");
    b.tick(2 * 60 + 59); // 21:59
    expect(b.granted("long")).toBe(false);
    b.tick(1); // 22:00
    expect(b.granted("long")).toBe(true);
    expect(b.granted("r")).toBe(true);
  });

  it("runs at once when no higher-class run is there", () => {
    const b = bed(WINDOWED);
    b.ask("long", { project: "app", estimateMin: 60 });
    expect(b.granted("long")).toBe(true);
  });

  it("inside the window (past midnight too) it runs at once", () => {
    const b = bed(WINDOWED, new Date(2026, 10, 21, 5, 0, 0).getTime());
    b.ask("r", { project: "rel-repo", estimateMin: 600 });
    b.ask("long", { project: "app", estimateMin: 60 });
    expect(b.granted("long")).toBe(true);
  });

  it("a waiting release run holds it back too", () => {
    const b = bed({ ...WINDOWED, cpu_slots: 1 });
    b.ask("holder", { project: "app", estimateMin: 10 });
    b.ask("r", { project: "rel-repo", estimateMin: 10 });
    b.ask("long", { project: "app", estimateMin: 60 });
    expect(b.waiting()).toEqual(["r", "long"]);
  });
});

describe("visible: gate status, the queue view, the slot log", () => {
  it("each entry's class shows", async () => {
    const b = bed(CLASSES);
    const h = b.ask("holder", { project: "app" });
    const r = b.ask("r", { project: "rel-repo" });
    const { d, out } = deps(b.store, b.now);
    await cmdGate(["status"], d);
    expect(out.find((l) => l.startsWith(r.id))).toContain("class release");
    expect(out.find((l) => l.startsWith(h.id))).toContain("class other");
    const v = gateView(b.store, b.now());
    expect(v.slots.map((s) => s.class)).toEqual(["other", "release"]);
    const asked = b.store.events().filter((e) => e.event === "asked");
    expect(asked.map((e) => e.class)).toEqual(["other", "release"]);
  });

  it("an MCP ask's project is the agent's project", async () => {
    const b = bed({ ...CLASSES, class_map: "north=release, *=other" });
    const api = {
      baseUrl: "http://localhost:47003",
      async get() {
        return { active: ["north"], workspaces: { north: {} } };
      },
    } as unknown as DenApi;
    const ctx: ToolContext = {
      api,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      } as unknown as ToolContext["cfg"],
      cli: "acme",
      scope: { workspace: "north", actor: "agent:coder" },
      gates: b.store,
    };
    const r = await callTool("gate_slot_request", { kind: "cpu" }, ctx);
    expect(JSON.parse(r.text)).toMatchObject({ class: "release" });
  });
});

describe("clause 6: the settings", () => {
  it("are checked, and set with gate settings (a person's)", async () => {
    expect(checkGatePatch(CLASSES).ok).toBe(true);
    expect(checkGatePatch({ class_order: "Release!" }).ok).toBe(false);
    expect(checkGatePatch({ class_map: "app" }).ok).toBe(false);
    expect(checkGatePatch({ class_windows: "other=25:00-06:00" }).ok).toBe(
      false,
    );
    expect(checkGatePatch({ class_order: null }).ok).toBe(true);
    const b = bed();
    const { d, out } = deps(b.store, b.now);
    expect(
      await cmdGate(
        [
          "settings",
          "--class-order",
          "release,other",
          "--class-map",
          "rel-repo=release",
          "--class-windows",
          "other=22:00-06:00/30",
        ],
        d,
      ),
    ).toBe(0);
    expect(b.store.settings().classes).toMatchObject({
      order: ["release", "other"],
    });
    expect(out.join("\n")).toContain("release, other");
    const agent = deps(b.store, b.now);
    agent.d.env = { DEN_AGENT: "agent:coder" };
    expect(await cmdGate(["settings", "--class-order", "a,b"], agent.d)).toBe(
      2,
    );
  });

  it("have Settings rows in en, es and ja", () => {
    const pub = path.join(process.cwd(), "src/ui/server/public");
    const reg = fs.readFileSync(
      path.join(pub, "settings-registry.js"),
      "utf-8",
    );
    for (const id of [
      "gate_class_order",
      "gate_class_map",
      "gate_class_windows",
    ]) {
      expect(reg).toContain(`id: "server.${id}"`);
      for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
        const s = fs.readFileSync(path.join(pub, f), "utf-8");
        expect(s).toContain(`"set.server.${id}":`);
        expect(s).toContain(`"set.server.${id}.d":`);
      }
    }
  });
});
