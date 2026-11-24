/**
 * Issue 1395: gate_settings_set, the held write an agent uses to ask for
 * a change to the machine's gate slot settings (the gates folder's
 * settings.json, which setting_change can't reach). Same keys and ranges
 * as Settings › Gate (checkGatePatch). The card shows each key's value now
 * and the one asked for. Gate keys are Limits and performance:
 *  - a personal install: every key is routine (Den Builder's ruling),
 *    so it is written at once and the person is told;
 *  - a strict install: they follow the person's choice for Limits (by
 *    default written and told; "Ask me" holds it for Allow), every key
 *    alike: none of them widens what agents may do.
 * On Allow the one writer (GateStore.writeSettings, under the gate's
 * lock) writes them; a refused value writes nothing. A temp gates
 * folder; invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_LIMITS,
  GATE_TEXT,
  GateStore,
} from "../../../src/shared/gates/store.js";
import {
  GATE_SETTINGS_SET_ACTION,
  checkGateSettingsSet,
  runGateSettingsSet,
  type GateSettingsSetDeps,
} from "../../../src/shared/gates/settings-set.js";
import {
  HELD_WRITE_RISK,
  criticalWhy,
  policyFor,
  readPolicySetting,
} from "../../../src/shared/approval-policy.js";
import type { InstallMode } from "../../../src/shared/den-config.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";

let dir = "";
let store: GateStore;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1395-")));
  store = new GateStore({ dir, lockWaitMs: 1_000 });
  store.writeSettings({ cpu_slots: 2 }, "a person");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function deps(mode: InstallMode, limits?: "auto" | "ask" | "never") {
  const d: GateSettingsSetDeps = {
    settings: (patch) => store.settings(patch),
    write: async (patch, by) => store.writeSettings(patch, by),
    installMode: () => mode,
    kind: (key, value) => settingKind(key, mode, value),
    choices: () =>
      readPolicySetting(limits ? { settings: { limits } } : {})?.settings,
  };
  return d;
}

/** What the approval routes do with a checked ask (approval-routes.ts). */
function outcome(
  mode: InstallMode,
  c: { personOnly?: boolean; category?: string },
  limits?: "auto" | "ask" | "never",
): "held" | "written and told" | "written" {
  if (criticalWhy(GATE_SETTINGS_SET_ACTION, !!c.personOnly, undefined, mode))
    return "held";
  const p = policyFor(GATE_SETTINGS_SET_ACTION, {
    widens: !!c.personOnly,
    mode,
    ...(c.category ? { setting: { category: c.category as never } } : {}),
    install: readPolicySetting(limits ? { settings: { limits } } : {}),
  });
  return p.kind === "ask"
    ? "held"
    : p.kind === "notify"
      ? "written and told"
      : "written";
}

const ASK = { settings: { cpu_slots: 3 }, reason: "two browser runs wait" };

describe("issue 1395: gate_settings_set", () => {
  it("is a placed held write", () => {
    expect(GATE_SETTINGS_SET_ACTION).toBe("gate_settings_set");
    expect(Object.hasOwn(HELD_WRITE_RISK, "gate_settings_set")).toBe(true);
    // Not kept held on personal installs (Den Builder's ruling).
    expect(HELD_WRITE_RISK.gate_settings_set!.personal).toBeUndefined();
  });

  it("the card shows each key's value now and the one asked for", () => {
    const c = checkGateSettingsSet(deps("personal"), {
      settings: { cpu_slots: 3, reap_grace_seconds: 20 },
      reason: "two browser runs wait",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.category).toBe("limits");
    expect(c.details).toEqual(
      expect.arrayContaining([
        "gate.cpu_slots: 2 → 3",
        `gate.reap_grace_seconds: ${store.settings().reapGraceSeconds} → 20`,
        "Why: two browser runs wait",
      ]),
    );
    expect(c.detailKeys.map((k) => k.key)).toEqual(
      expect.arrayContaining([
        "ap.det.gate_settings_set.change",
        "ap.det.gate_settings_set.why",
        "ap.det.gate_settings_set.writes",
      ]),
    );
  });

  it("a personal install: an agent's change is written at once, and the person is told", async () => {
    const c = checkGateSettingsSet(deps("personal"), ASK);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(outcome("personal", c)).toBe("written and told");
    // priority_agents too: every gate key is routine on personal.
    const pa = checkGateSettingsSet(deps("personal"), {
      settings: { priority_agents: 0 },
      reason: "people only tonight",
    });
    expect(pa.ok).toBe(true);
    if (pa.ok) expect(outcome("personal", pa)).toBe("written and told");
    const r = await runGateSettingsSet(deps("personal"), ASK, {
      agent: "agent:gate-tuner",
    });
    expect(r).toMatchObject({ ok: true });
    expect(store.settings().cpuSlots).toBe(3);
    // The slot log names who asked, with the key's before and after.
    const row = store.settingsChanges().pop()!;
    expect(row.by).toMatch(/gate-tuner/);
    expect(row.changes.cpu_slots).toEqual({ from: 2, to: 3 });
  });

  it("a strict install, Limits on its default (ask): held; on auto: written, and the person is told", () => {
    const c = checkGateSettingsSet(deps("strict"), ASK);
    expect(c.ok).toBe(true);
    if (c.ok) expect(outcome("strict", c)).toBe("held");
    const auto = checkGateSettingsSet(deps("strict", "auto"), ASK);
    expect(auto.ok).toBe(true);
    if (auto.ok)
      expect(outcome("strict", auto, "auto")).toBe("written and told");
  });

  it("a strict install, Limits on Ask me: held, and written only after Allow", async () => {
    const c = checkGateSettingsSet(deps("strict", "ask"), ASK);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(outcome("strict", c, "ask")).toBe("held");
    expect(store.settings().cpuSlots).toBe(2);
    // The person's Allow runs it.
    await runGateSettingsSet(deps("strict", "ask"), ASK, { agent: "agent:x" });
    expect(store.settings().cpuSlots).toBe(3);
  });

  it("a strict install: priority_agents follows the Limits choice too (it doesn't widen)", () => {
    // Off first (a person's choice), so the ask turns it back on.
    store.writeSettings({ priority_agents: 0 }, "a person");
    const c = checkGateSettingsSet(deps("strict"), {
      settings: { priority_agents: 1 },
      reason: "let agents take release priority",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(outcome("strict", c, "auto")).toBe("written and told");
    expect(outcome("strict", c)).toBe("held");
  });

  it("Limits on Never: refused, nothing written", async () => {
    const c = checkGateSettingsSet(deps("strict", "never"), ASK);
    expect(c.ok).toBe(false);
    const r = await runGateSettingsSet(deps("strict", "never"), ASK);
    expect(r.ok).toBe(false);
    expect(store.settings().cpuSlots).toBe(2);
  });

  it("an out-of-range value, an unknown key, no reason, or no change: refused, nothing written", async () => {
    const rows = store.settingsChanges().length;
    for (const bad of [
      { settings: { cpu_slots: 0 }, reason: "x" },
      { settings: { cpu_slots: 2.5 }, reason: "x" },
      { settings: { not_a_gate_key: 1 }, reason: "x" },
      { settings: {}, reason: "x" },
      { settings: { cpu_slots: 3 } },
    ]) {
      const c = checkGateSettingsSet(deps("personal"), bad);
      expect(c.ok).toBe(false);
      const r = await runGateSettingsSet(deps("personal"), bad);
      expect(r.ok).toBe(false);
    }
    // No change: refused at the ask; on Allow, done with nothing written.
    const same = { settings: { cpu_slots: 2 }, reason: "x" };
    expect(checkGateSettingsSet(deps("personal"), same).ok).toBe(false);
    expect(await runGateSettingsSet(deps("personal"), same)).toMatchObject({
      ok: true,
      changed: [],
    });
    expect(store.settings().cpuSlots).toBe(2);
    expect(store.settingsChanges().length).toBe(rows);
  });

  it("checked again on Allow: a value now in place is done, and not written twice", async () => {
    store.writeSettings({ cpu_slots: 3 }, "a person");
    const rows = store.settingsChanges().length;
    const r = await runGateSettingsSet(deps("personal"), ASK);
    expect(r).toEqual({ ok: true, changed: [], note: "already in effect" });
    expect(store.settingsChanges().length).toBe(rows);
  });
});

describe("issue 1395: every gate key is placed for the approval policy", () => {
  it("each of Settings › Gate's keys is a limit that doesn't widen, on both modes", () => {
    const all = [...Object.keys(GATE_LIMITS), ...Object.keys(GATE_TEXT)].map(
      (k) => `gate.${k}`,
    );
    for (const k of all) {
      expect([k, settingKind(k, "personal").widens]).toEqual([k, false]);
      expect([k, settingKind(k, "strict").widens]).toEqual([k, false]);
      expect([k, settingKind(k).category]).toEqual([k, "limits"]);
    }
  });

  it("a key may be given as gate.<key>", () => {
    const c = checkGateSettingsSet(deps("personal"), {
      settings: { "gate.cpu_slots": 3 },
      reason: "two browser runs wait",
    });
    expect(c.ok && c.args.settings).toEqual({ cpu_slots: 3 });
  });
});

describe("issue 1395: the policy sees each value as it'd be in effect", () => {
  it("a key put back to its default is judged by that default, which depends on the platform", () => {
    // Not a Mac: browser_requires_container defaults to 0.
    const linux = new GateStore({ dir, lockWaitMs: 1_000, platform: "linux" });
    linux.writeSettings({ browser_requires_container: 1 }, "a person");
    const seen: [string, unknown][] = [];
    const d: GateSettingsSetDeps = {
      ...deps("strict"),
      settings: (patch) => linux.settings(patch),
      kind: (key, value) => {
        seen.push([key, value]);
        return settingKind(key, "strict");
      },
    };
    const c = checkGateSettingsSet(d, {
      settings: { browser_requires_container: null },
      reason: "back to the default",
    });
    expect(c.ok).toBe(true);
    expect(seen).toEqual([["gate.browser_requires_container", 0]]);
    if (c.ok)
      expect(c.details).toContain(
        "gate.browser_requires_container: 1 → default (0)",
      );
    // The preview wrote nothing.
    expect(linux.settings().browserRequiresContainer).toBe(true);
  });
});

describe("issue 1395: Vision's ruling, a browser run on the host", () => {
  const OFF = {
    settings: { browser_requires_container: 0 },
    reason: "the container image is broken tonight",
  };
  const mac = () => {
    const s = new GateStore({ dir, lockWaitMs: 1_000, platform: "darwin" });
    return {
      store: s,
      deps: (mode: InstallMode, limits?: "auto" | "ask" | "never") => ({
        ...deps(mode, limits),
        settings: (patch?: Parameters<GateStore["settings"]>[0]) =>
          s.settings(patch),
        write: async (
          patch: Parameters<GateStore["writeSettings"]>[0],
          by: string,
        ) => s.writeSettings(patch, by),
      }),
    };
  };

  it("strict: turning the container off widens, so it waits for the person's Allow", async () => {
    const m = mac();
    const c = checkGateSettingsSet(m.deps("strict"), OFF);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(outcome("strict", c)).toBe("held");
    expect(m.store.settings().browserRequiresContainer).toBe(true);
    await runGateSettingsSet(m.deps("strict"), OFF, { agent: "agent:x" });
    expect(m.store.settings().browserRequiresContainer).toBe(false);
  });

  it("strict: turning it back on is a plain limit", () => {
    const m = mac();
    m.store.writeSettings({ browser_requires_container: 0 }, "a person");
    const c = checkGateSettingsSet(m.deps("strict"), {
      settings: { browser_requires_container: 1 },
      reason: "the image is fixed",
    });
    expect(c.ok && c.personOnly).toBeFalsy();
    if (c.ok) expect(outcome("strict", c, "auto")).toBe("written and told");
  });

  it("strict: a reset to a default of 0 (not a Mac) widens too", () => {
    const linux = new GateStore({ dir, lockWaitMs: 1_000, platform: "linux" });
    linux.writeSettings({ browser_requires_container: 1 }, "a person");
    const c = checkGateSettingsSet(
      { ...deps("strict"), settings: (p) => linux.settings(p) },
      { settings: { browser_requires_container: null }, reason: "default" },
    );
    expect(c.ok && c.personOnly).toBe(true);
  });

  it("personal: routine, written at once, and the person is told", () => {
    const m = mac();
    const c = checkGateSettingsSet(m.deps("personal"), OFF);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(outcome("personal", c)).toBe("written and told");
  });
});
