import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { onOff } from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const ROUTE = path.resolve("src/shared/agents/guardrails/gate-route.mjs");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1730-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function gateDir(settings?: Record<string, unknown>): string {
  const d = path.join(root, `g${n++}`);
  fs.mkdirSync(d);
  if (settings)
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings));
  return d;
}

const ON: unknown[] = [1, 1.0, true, "1", "yes", "on", "true", " Yes ", "ON"];
const OFF: unknown[] = [0, false, "0", "no", "off", "false", " No "];
const UNREADABLE: unknown[] = [0.5, 0.2, 2, -1, "maybe", "", {}, [], null];

function hookReads(files: string[]): boolean[] {
  const js = `
    const { routeSettings } = await import(${JSON.stringify(HOOK)});
    const files = ${JSON.stringify(files)};
    console.log(JSON.stringify(files.map((f) => routeSettings(f).on)));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("onOff: the rules.ts copy and the gate-route.mjs copy", () => {
  const table: unknown[] = [
    ...ON,
    ...OFF,
    ...UNREADABLE,
    "TRUE",
    "False",
    "1.0",
    " ",
    "y",
    "n",
    NaN,
    Infinity,
    1.0000001,
    -0,
  ];

  it("give the same answer for every value in one table", () => {
    const js = `
      const { onOff } = await import(${JSON.stringify(ROUTE)});
      const t = JSON.parse(process.argv[1]).map((x) => (x === "__NaN" ? NaN : x === "__Inf" ? Infinity : x));
      console.log(JSON.stringify(t.map(onOff)));`;
    const wire = JSON.stringify(
      table.map((x) =>
        Number.isNaN(x) ? "__NaN" : x === Infinity ? "__Inf" : x,
      ),
    );
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", js, wire],
      { encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    const mjs = JSON.parse(r.stdout.trim().split("\n").pop()!);
    const ts = table.map(onOff);
    expect(mjs).toEqual(ts);
    expect(ts).toEqual([
      ...ON.map(() => true),
      ...OFF.map(() => false),
      ...UNREADABLE.map(() => null),
      true,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
    ]);
  });
});

describe("route_agents as read from a hand-edited settings.json", () => {
  const cases: [unknown, boolean][] = [
    ...ON.map((v): [unknown, boolean] => [v, true]),
    ...OFF.map((v): [unknown, boolean] => [v, false]),
    ...UNREADABLE.map((v): [unknown, boolean] => [v, true]),
  ];

  it.each(cases)("the store reads %p as %p", (v, want) => {
    const s = new GateStore({ dir: gateDir({ route_agents: v }) });
    expect(s.settings().routeAgents).toBe(want);
  });

  it("the agent hook reads every one the same as the store", () => {
    const dirs = cases.map(([v]) => gateDir({ route_agents: v }));
    const hook = hookReads(dirs.map((d) => path.join(d, "settings.json")));
    const store = dirs.map(
      (d) => new GateStore({ dir: d }).settings().routeAgents,
    );
    expect(hook).toEqual(store);
    expect(hook).toEqual(cases.map(([, want]) => want));
  });

  it("no setting: on", () => {
    expect(new GateStore({ dir: gateDir({}) }).settings().routeAgents).toBe(
      true,
    );
    expect(hookReads([path.join(gateDir({}), "settings.json")])).toEqual([
      true,
    ]);
  });
});

describe("route_agents at the boundary (checkGatePatch)", () => {
  it.each(ON)("%p is accepted and saved as 1", (v) => {
    const p = checkGatePatch({ route_agents: v });
    expect(p).toEqual({ ok: true, patch: { route_agents: 1 } });
  });

  it.each(OFF)("%p is accepted and saved as 0", (v) => {
    const p = checkGatePatch({ route_agents: v });
    expect(p).toEqual({ ok: true, patch: { route_agents: 0 } });
  });

  it.each(UNREADABLE.filter((v) => v !== null))(
    "%p is refused, naming the key and the forms it takes",
    (v) => {
      const p = checkGatePatch({ route_agents: v });
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.error).toContain("gate_slots.route_agents");
        expect(p.error).toMatch(/on .*off/);
      }
    },
  );

  it("null still clears it back to the default", () => {
    expect(checkGatePatch({ route_agents: null })).toEqual({
      ok: true,
      patch: { route_agents: null },
    });
  });

  it("the saved file keeps the number form", () => {
    const d = gateDir();
    const s = new GateStore({ dir: d });
    const p = checkGatePatch({ route_agents: "no" });
    s.writeSettings(p.ok ? p.patch : {}, "a person");
    const saved = JSON.parse(
      fs.readFileSync(path.join(d, "settings.json"), "utf8"),
    );
    expect(saved.route_agents).toBe(0);
    expect(s.settings().routeAgents).toBe(false);
  });
});

describe("route_agents through the CLI and the approval check", () => {
  function deps(): GateDeps {
    return {
      store: new GateStore({
        platform: "linux",
        dir: gateDir(),
        alive: () => true,
      }),
      env: {},
      out: () => {},
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/some-repo",
      lang: "en",
    };
  }

  it("gate settings --route-agents no turns it off; yes turns it on", async () => {
    const d = deps();
    expect(await cmdGate(["settings", "--route-agents", "no"], d)).toBe(0);
    expect(d.store.settings().routeAgents).toBe(false);
    expect(await cmdGate(["settings", "--route-agents", "yes"], d)).toBe(0);
    expect(d.store.settings().routeAgents).toBe(true);
  });

  it("gate settings --route-agents maybe is refused, and changes nothing", async () => {
    const d = deps();
    expect(await cmdGate(["settings", "--route-agents", "maybe"], d)).not.toBe(
      0,
    );
    expect(d.store.settings().routeAgents).toBe(true);
  });

  for (const mode of ["personal", "strict"] as const) {
    it(`${mode}: "no" from on widens; "yes" from off doesn't`, () => {
      expect(settingKind("gate.route_agents", mode, "no", 1).widens).toBe(true);
      expect(settingKind("gate.route_agents", mode, false, true).widens).toBe(
        true,
      );
      expect(settingKind("gate.route_agents", mode, "yes", 0).widens).toBe(
        false,
      );
      expect(settingKind("gate.route_agents", mode, true, false).widens).toBe(
        false,
      );
    });
  }
});
