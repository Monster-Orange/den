/**
 * Issue 1264, slice 2: a heavy run Den's hook leaves alone (a compound
 * command, or routing turned off) is recorded in the gate's slot log as
 * "ran outside the gate", with the program and the agent, never its
 * arguments. The gate counts those runs per agent today, and the two
 * routing settings (route_agents, route_commands) are gate settings like
 * the others.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { readSettingsSources } from "../server/helpers/settings-sources.js";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-outside-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A gate folder of its own, with these settings. */
function gateDir(settings?: Record<string, unknown>): string {
  const d = path.join(root, `g${n++}`);
  fs.mkdirSync(d);
  if (settings)
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings));
  return d;
}

function hook(dir: string, command: string, agent = "den-lane-x") {
  const r = spawnSync(
    process.execPath,
    [
      HOOK,
      "--gate",
      "/opt/den/bin/den",
      "--gate-settings",
      path.join(dir, "settings.json"),
    ],
    {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
        cwd: root,
      }),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: root, DEN_AGENT: agent },
    },
  );
  return { code: r.status, stdout: r.stdout };
}

function rows(dir: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(path.join(dir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("issue 1264: a heavy run the hook leaves alone is in the slot log", () => {
  it("a compound command: left as it is, recorded with the program and the agent, never its arguments", () => {
    const d = gateDir();
    const r = hook(d, "cd w && npx jest secret-name.test.ts --token=abc123");
    expect([r.code, r.stdout]).toEqual([0, ""]);
    const all = rows(d);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      event: "outside",
      kind: "cpu",
      who: "den-lane-x",
      label: "jest",
    });
    const text = fs.readFileSync(path.join(d, "events.jsonl"), "utf-8");
    expect(text).not.toContain("secret-name");
    expect(text).not.toContain("abc123");
  });

  it("routing off (route_agents 0): runs as it is, recorded as a browser run for Playwright", () => {
    const d = gateDir({ route_agents: 0 });
    expect(hook(d, "npx playwright test e").stdout).toBe("");
    expect(rows(d)).toEqual([
      expect.objectContaining({
        event: "outside",
        kind: "browser",
        label: "playwright",
      }),
    ]);
  });

  it("route_agents false (slice 1's form) is off too", () => {
    const d = gateDir({ route_agents: false });
    expect(hook(d, "npx jest a.test.ts").stdout).toBe("");
    expect(rows(d)).toHaveLength(1);
  });

  it("route_commands as the gate stores it (a line of text): its programs only", () => {
    const d = gateDir({ route_commands: "tsc, npm test" });
    expect(hook(d, "npx tsc -p .").stdout).toContain("gate run --kind cpu");
    expect(hook(d, "npx jest a.test.ts").stdout).toBe("");
    // jest isn't on this list: not heavy here, so not recorded either.
    expect(rows(d)).toEqual([]);
  });

  it("a routed run, or one with no heavy program: nothing recorded", () => {
    const d = gateDir();
    expect(hook(d, "npx jest a.test.ts").stdout).toContain("gate run");
    expect(hook(d, "git status && ls").stdout).toBe("");
    expect(rows(d)).toEqual([]);
  });
});

describe("issue 1264: the gate counts outside runs per agent today", () => {
  const dayAt = (h: number, dayOffset = 0) => {
    const t = new Date(2026, 10, 22, h, 0, 0);
    t.setDate(t.getDate() + dayOffset);
    return t;
  };
  const now = dayAt(15).getTime();

  function store(): GateStore {
    const d = gateDir();
    const line = (at: Date, who: string, event = "outside") =>
      JSON.stringify({
        at: at.toISOString(),
        event,
        id: "outside",
        kind: "cpu",
        who,
        label: "jest",
      });
    fs.writeFileSync(
      path.join(d, "events.jsonl"),
      [
        line(dayAt(23, -1), "den-lane-a"), // yesterday: not counted
        line(dayAt(1), "den-lane-a"),
        line(dayAt(9), "den-lane-b"),
        line(dayAt(14), "den-lane-a"),
        line(dayAt(10), "den-lane-b", "granted"), // a gated run
      ].join("\n") + "\n",
    );
    return new GateStore({ dir: d, now: () => now });
  }

  it("outsideToday: today's outside runs per agent, most first", () => {
    expect(store().outsideToday()).toEqual([
      { who: "den-lane-a", count: 2 },
      { who: "den-lane-b", count: 1 },
    ]);
  });

  it("none today: an empty list", () => {
    expect(
      new GateStore({ dir: gateDir(), now: () => now }).outsideToday(),
    ).toEqual([]);
  });

  it("the gate's view carries the counts (the Gate settings page reads them)", () => {
    expect(gateView(store(), now).outsideToday).toEqual([
      { who: "den-lane-a", count: 2 },
      { who: "den-lane-b", count: 1 },
    ]);
  });
});

describe("issue 1264: route_agents and route_commands are gate settings", () => {
  it("a change to either is accepted and read back", () => {
    const p = checkGatePatch({
      route_agents: 0,
      route_commands: "jest, npm run test*",
    });
    expect(p.ok).toBe(true);
    const d = gateDir();
    const s = new GateStore({ dir: d });
    s.writeSettings(p.ok ? p.patch : {}, "a person");
    expect(s.settings()).toMatchObject({
      routeAgents: false,
      routeCommands: ["jest", "npm run test*"],
    });
  });

  it("defaults: on, with the issue's list", () => {
    expect(new GateStore({ dir: gateDir() }).settings()).toMatchObject({
      routeAgents: true,
      routeCommands: [
        "jest",
        "vitest",
        "tsc",
        "playwright",
        "npm test",
        "npm run test*",
      ],
    });
  });

  it("a list entry with shell syntax, or route_agents other than 0 or 1, is refused", () => {
    expect(checkGatePatch({ route_commands: "jest; rm -rf d" }).ok).toBe(false);
    expect(checkGatePatch({ route_commands: "$(x)" }).ok).toBe(false);
    expect(checkGatePatch({ route_agents: 2 }).ok).toBe(false);
  });
});

describe("issue 1264: the CLI and the Settings page show and change routing", () => {
  function deps(): { d: GateDeps; out: string[] } {
    const out: string[] = [];
    const d: GateDeps = {
      store: new GateStore({
        platform: "linux",
        dir: gateDir(),
        alive: () => true,
      }),
      env: {},
      out: (l) => out.push(l),
      err: (l) => out.push(l),
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
    return { d, out };
  }

  it('gate settings --route-agents 0 --route-commands "jest, tsc" writes both', async () => {
    const t = deps();
    expect(
      await cmdGate(
        ["settings", "--route-agents", "0", "--route-commands", "jest, tsc"],
        t.d,
      ),
    ).toBe(0);
    expect(t.d.store.settings()).toMatchObject({
      routeAgents: false,
      routeCommands: ["jest", "tsc"],
    });
  });

  it("an agent can't change them", async () => {
    const t = deps();
    t.d.env = { DEN_AGENT: "den-lane-x" };
    expect(await cmdGate(["settings", "--route-agents", "0"], t.d)).not.toBe(0);
    expect(t.d.store.settings().routeAgents).toBe(true);
  });

  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");

  it("en, es and ja have the rows' words and the count's", () => {
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = read(f);
      for (const k of [
        "gate_route_agents",
        "gate_route_commands",
        "gate_outside",
      ]) {
        expect(src).toContain(`"set.server.${k}":`);
        expect(src).toContain(`"set.server.${k}.d":`);
      }
      expect(src).toMatch(/"set\.ui\.outsideRuns":\s*"[^"]*\{n\}/);
      // A singular form where the language has one (not ja).
      if (f !== "i18n/ja.js")
        expect(src).toMatch(/"set\.ui\.outsideRuns\.one":\s*"[^"]*\{n\}/);
      expect(src).toContain('"set.ui.outsideNone":');
      expect(src).toContain('"set.ui.outsideFailed":');
    }
  });

  it("the Settings rows: the two settings, and today's counts from the gate's view", () => {
    const reg = readSettingsSources();
    expect(reg).toContain('"gate_slots.route_agents"');
    expect(reg).toContain('"gate_slots.route_commands"');
    expect(reg).toContain('id: "server.gate_outside"');
    expect(reg).toMatch(
      /function drawGateOutside[\s\S]*\/api\/gate-slots[\s\S]*outsideToday/,
    );
  });
});
