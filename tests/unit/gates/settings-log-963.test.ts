/**
 * Issue 963: a gate settings change is recorded (who, when, old and new),
 * release priority being off is said plainly, each setting says what it
 * means (en, es, ja), and turning release priority off warns first.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { UiLanguage } from "../../../src/shared/gates/browser-container.js";
import { GATE_MEANINGS } from "../../../src/shared/gates/meanings.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { product } from "../../../src/shared/product.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function deps(over: Partial<GateDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate963-"));
  tmps.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store: new GateStore({ platform: "linux", dir, alive: () => true }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    lang: "en",
    ...over,
  };
  return { d, out, err };
}

describe("issue 963: a settings change is in the slot log", () => {
  it("one row: who (as for asks), when, each key's old and new value", async () => {
    const t = deps();
    expect(
      await cmdGate(
        ["settings", "--cpu-slots", "4", "--priority-pass-limit-minutes", "5"],
        t.d,
      ),
    ).toBe(0);
    const rows = t.d.store.settingsChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "settings",
      // Named as an ask is: the install's product title, the repo, who.
      by: `${product().title} · some-repo · a person`,
      changes: {
        cpu_slots: { from: 2, to: 4 },
        priority_pass_limit_minutes: { from: 0, to: 5 },
      },
    });
    expect(Date.parse(rows[0].at)).not.toBeNaN();
  });

  it("a value cleared to its default says so; an unchanged value writes no row", async () => {
    const t = deps();
    await cmdGate(["settings", "--cpu-slots", "4"], t.d);
    await cmdGate(["settings", "--cpu-slots", "4"], t.d);
    expect(t.d.store.settingsChanges()).toHaveLength(1);
    t.d.store.writeSettings({ cpu_slots: null }, "a test");
    expect(t.d.store.settingsChanges().at(-1)).toMatchObject({
      by: "a test",
      changes: { cpu_slots: { from: 4, to: 2 } },
    });
  });

  it("the run rows stay as they were: a settings row isn't one of them", async () => {
    const t = deps();
    await cmdGate(["settings", "--cpu-slots", "4"], t.d);
    expect(t.d.store.events()).toEqual([]);
  });
});

describe("issue 963: release priority off is said plainly", () => {
  it("gate settings and gate status say so", async () => {
    const t = deps();
    expect(
      await cmdGate(["settings", "--priority-max", "0", "--yes"], t.d),
    ).toBe(0);
    expect(t.out.at(-1)).toContain("release priority: off (priority_max 0)");
    await cmdGate(["status"], t.d);
    expect(t.out.at(-1)).toBe("release priority: off (priority_max 0)");
  });

  it("on (the default), status says nothing of it", async () => {
    const t = deps();
    await cmdGate(["status"], t.d);
    expect(t.out.join("\n")).not.toMatch(/release priority/);
  });

  it("a release ask with it off runs as an ordinary run, and says why", async () => {
    const t = deps();
    t.d.store.writeSettings({ priority_max: 0 }, "a test");
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "cpu",
          "--priority",
          "release",
          "--reason",
          "a person waits",
          "--",
          "true",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.err.join("\n")).toContain(
      "taken as an ordinary run: release priority is off on this machine (priority_max 0)",
    );
  });
});

describe("issue 963: each setting says what it means", () => {
  const KEYS = [
    "cpu_slots",
    "cpu_slots_beside_browser",
    "cpu_slots_beside_release_browser",
    "cpu_hold_load",
    "local_browser_slots",
    "overrun_margin_minutes",
    "remote_renew_seconds",
    "remote_lapse_seconds",
    "remote_max_slots",
    "remote_max_asks",
    "priority_max",
    "priority_pass_limit_minutes",
    "priority_agents",
    "priority_runners",
    "claim_minutes",
    "mcp_renew_minutes",
    "mcp_lapse_minutes",
    "mcp_grace_minutes",
    "box_check_timeout_seconds",
    "box_recheck_seconds",
    "browser_requires_container",
    "class_order",
    "class_map",
    "class_windows",
    "browser_box_default",
    "browser_host_only",
  ];

  it.each(["en", "es", "ja"] as UiLanguage[])(
    "every key has its meaning in %s",
    (lang) => {
      for (const k of KEYS)
        expect(
          GATE_MEANINGS[lang][k as keyof (typeof GATE_MEANINGS)["en"]],
        ).toBeTruthy();
      expect(Object.keys(GATE_MEANINGS[lang]).sort()).toEqual([...KEYS].sort());
    },
  );

  it("es and ja are their own words, not the English", () => {
    for (const k of KEYS) {
      const key = k as keyof (typeof GATE_MEANINGS)["en"];
      expect(GATE_MEANINGS.es[key]).not.toBe(GATE_MEANINGS.en[key]);
      expect(GATE_MEANINGS.ja[key]).not.toBe(GATE_MEANINGS.en[key]);
    }
  });

  it.each(["en", "es", "ja"] as UiLanguage[])(
    "gate settings lists each key with its meaning, in %s",
    async (lang) => {
      const t = deps({ lang });
      expect(await cmdGate(["settings"], t.d)).toBe(0);
      const text = t.out.join("\n");
      for (const k of KEYS)
        expect(text).toContain(
          `${k}: ${GATE_MEANINGS[lang][k as keyof (typeof GATE_MEANINGS)["en"]]}`,
        );
    },
  );

  it("the priority_max meaning says 0 turns it off", () => {
    expect(GATE_MEANINGS.en.priority_max).toBe(
      "Release runs ahead of plain runs, per kind (default 1; 0 turns release priority off)",
    );
  });
});

describe("issue 963: turning release priority off warns first", () => {
  it("without --yes: the warning, nothing changed", async () => {
    const t = deps();
    expect(await cmdGate(["settings", "--priority-max", "0"], t.d)).toBe(1);
    expect(t.err.join("\n")).toMatch(/turns release priority off.*--yes/s);
    expect(t.d.store.settings().priorityMax).toBe(1);
    expect(t.d.store.settingsChanges()).toEqual([]);
  });

  it("with --yes: it goes through, and is in the slot log", async () => {
    const t = deps();
    expect(
      await cmdGate(["settings", "--priority-max", "0", "--yes"], t.d),
    ).toBe(0);
    expect(t.d.store.settings().priorityMax).toBe(0);
    expect(t.d.store.settingsChanges().at(-1)?.changes).toEqual({
      priority_max: { from: 1, to: 0 },
    });
  });

  it("any other value needs no --yes", async () => {
    const t = deps();
    expect(await cmdGate(["settings", "--priority-max", "2"], t.d)).toBe(0);
  });
});
