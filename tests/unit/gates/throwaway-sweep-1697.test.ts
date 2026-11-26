import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readPolicySetting } from "../../../src/shared/approval-policy.js";
import type { InstallMode } from "../../../src/shared/den-config.js";
import type { Docker } from "../../../src/shared/gates/ephemeral.js";
import { GATE_MEANINGS } from "../../../src/shared/gates/meanings.js";
import {
  checkGateSettingsSet,
  type GateSettingsSetDeps,
} from "../../../src/shared/gates/settings-set.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { throwawayLines } from "../../../src/ui/cli/doctor-throwaway.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";
import { GateNotices } from "../../../src/ui/server/gate-notices.js";
import { readSettingsSources } from "../server/helpers/settings-sources.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1697-")),
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

function deps(store: GateStore, mode: InstallMode): GateSettingsSetDeps {
  return {
    settings: (patch) => store.settings(patch),
    write: async (patch, by) => store.writeSettings(patch, by),
    installMode: () => mode,
    kind: (key, value, before) => settingKind(key, mode, value, before),
    choices: () =>
      readPolicySetting({ settings: { limits: "auto" } })?.settings,
  };
}

function notices(store: GateStore) {
  const calls: string[][] = [];
  const docker: Docker = async (args) => {
    calls.push(args);
    return { code: 0, out: "" };
  };
  const g = new GateNotices({
    store: () => store,
    install: "/x",
    projectOf: () => null,
    relay: async () => true,
    bell: () => {},
    docker,
  });
  g.start();
  return { g, calls };
}

describe("gate.throwaway_sweep: the setting", () => {
  it("is on by default", () => {
    expect(new GateStore({ dir: gateDir() }).settings().throwawaySweep).toBe(
      true,
    );
  });

  it("0 turns it off; 1 turns it on again", () => {
    const s = new GateStore({ dir: gateDir() });
    const off = checkGatePatch({ throwaway_sweep: 0 });
    expect(off.ok).toBe(true);
    s.writeSettings(off.ok ? off.patch : {}, "a person");
    expect(s.settings().throwawaySweep).toBe(false);
    const on = checkGatePatch({ throwaway_sweep: 1 });
    s.writeSettings(on.ok ? on.patch : {}, "a person");
    expect(s.settings().throwawaySweep).toBe(true);
  });

  it("a value other than 0 or 1 is refused, naming the key", () => {
    for (const v of [2, -1, 0.5, "off"]) {
      const p = checkGatePatch({ throwaway_sweep: v });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error).toContain("throwaway_sweep");
    }
  });

  it("has a meaning in each language", () => {
    for (const lang of Object.keys(
      GATE_MEANINGS,
    ) as (keyof typeof GATE_MEANINGS)[])
      expect(GATE_MEANINGS[lang].throwaway_sweep).toMatch(/\S/);
  });
});

describe("gate.throwaway_sweep through gate_settings_set", () => {
  for (const mode of ["personal", "strict"] as const) {
    it(`${mode}: off is accepted, and needs the person`, () => {
      const store = new GateStore({ dir: gateDir(), lockWaitMs: 1_000 });
      const c = checkGateSettingsSet(deps(store, mode), {
        settings: { throwaway_sweep: 0 },
        reason: "no docker on this machine",
      });
      expect(c.ok).toBe(true);
      if (c.ok) expect(c.personOnly).toBe(true);
    });

    it(`${mode}: on again is a plain limit`, () => {
      expect(settingKind("gate.throwaway_sweep", mode, 1, 0).widens).toBe(
        false,
      );
      expect(settingKind("gate.throwaway_sweep", mode, 0, 1).widens).toBe(true);
      expect(settingKind("gate.throwaway_sweep", mode, 0).widens).toBe(true);
    });
  }

  it("a bad value is refused by name", () => {
    const store = new GateStore({ dir: gateDir(), lockWaitMs: 1_000 });
    const c = checkGateSettingsSet(deps(store, "personal"), {
      settings: { throwaway_sweep: 3 },
      reason: "a typo",
    });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(JSON.stringify(c)).toContain("throwaway_sweep");
  });
});

describe("the server's sweeper follows the setting", () => {
  it("on (the default): the first tick looks for throwaway containers", async () => {
    const t = notices(new GateStore({ dir: gateDir() }));
    await t.g.tick();
    await t.g.sweeping;
    expect(t.calls.some((c) => c[0] === "ps")).toBe(true);
  });

  it("off: no tick runs docker", async () => {
    const t = notices(new GateStore({ dir: gateDir({ throwaway_sweep: 0 }) }));
    for (let i = 0; i < 3; i++) {
      await t.g.tick();
      await t.g.sweeping;
    }
    expect(t.calls).toEqual([]);
  });

  it("turned off while running: the next tick runs nothing", async () => {
    const dir = gateDir();
    const store = new GateStore({ dir });
    const t = notices(store);
    store.writeSettings({ throwaway_sweep: 0 }, "a person");
    await t.g.tick();
    await t.g.sweeping;
    expect(t.calls).toEqual([]);
  });
});

describe("doctor says when the sweep is off", () => {
  it("none left over: ok, and it says the sweep is off", () => {
    const r = throwawayLines([], new Set(), undefined, new Set(), false);
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toContain("sweep is off");
    expect(r.check.detail).toContain("gate.throwaway_sweep");
  });

  it("left over with the sweep off: the fix says to turn it on", () => {
    const r = throwawayLines(
      [
        {
          id: "c1",
          image: "postgres:16",
          run: "gone-run",
          created: "2026-11-25 10:00:00",
          store: null,
          mode: "remove",
          state: "exited",
          checkout: null,
        },
      ],
      new Set(),
      undefined,
      new Set(),
      false,
    );
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toContain("sweep is off");
    expect(r.check.fix).toContain("gate.throwaway_sweep");
  });

  it("on: the row reads as before", () => {
    expect(throwawayLines([], new Set()).check.detail).toBe("none left over");
  });
});

describe("the CLI and the Settings page", () => {
  function cli(): { d: GateDeps; out: string[] } {
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

  it("gate settings --throwaway-sweep 0 writes it; an agent can't", async () => {
    const t = cli();
    expect(await cmdGate(["settings", "--throwaway-sweep", "0"], t.d)).toBe(0);
    expect(t.d.store.settings().throwawaySweep).toBe(false);
    const a = cli();
    a.d.env = { DEN_AGENT: "den-lane-x" };
    expect(await cmdGate(["settings", "--throwaway-sweep", "0"], a.d)).not.toBe(
      0,
    );
    expect(a.d.store.settings().throwawaySweep).toBe(true);
  });

  it("a Settings row, with its words in en, es and ja", () => {
    expect(readSettingsSources()).toContain('"gate_slots.throwaway_sweep"');
    const pub = path.join(process.cwd(), "src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(pub, f), "utf-8");
      expect(src).toContain('"set.server.gate_throwaway_sweep":');
      expect(src).toContain('"set.server.gate_throwaway_sweep.d":');
    }
  });
});
