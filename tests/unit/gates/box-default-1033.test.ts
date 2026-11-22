/**
 * Issue 1033: a browser `gate run` with no --box takes the first free
 * browser slot among this machine and the test boxes (the setting
 * browser_box_default, default any). It stays here for --box local (or
 * this machine's own name), for a label or project marked host-only (the
 * setting browser_host_only), or when it can't go to a box (no
 * --base-url, no box serves its Playwright version, or it starts its own
 * browser container): then it says why in one line and never fails for
 * it. gate status and the slot record show the machine each run got.
 * No ssh and no browser: the box check and the command are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type BoxProbe } from "../../../src/shared/gates/boxes.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1033-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-22T12:00:00Z");

function storeWith(boxes: Record<string, unknown>[] = [{ name: "b1" }]) {
  const probe: BoxProbe = () => Promise.resolve({ state: "open" });
  const store = new GateStore({
    platform: "linux",
    dir: tmp(),
    alive: () => true,
    now: () => T0,
    probe,
  });
  for (const b of boxes)
    store.setBox({ ssh: "ci@b1.test", playwright: "ws://b1.test:3000", ...b });
  return store;
}

/** This machine's browser slot, held by another run. */
const holdHost = (store: GateStore) => {
  const h = store.ask({
    kind: "browser",
    who: "other",
    label: "held",
    pid: 1,
    estimateMin: 10,
  });
  expect(h.grantedAt).toBeDefined();
  expect(h.box).toBeUndefined();
  return h;
};

function deps(store: GateStore) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { cmd: string; env?: Record<string, string> }[] = [];
  let waits = 0;
  const d: GateDeps = {
    store,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => T0,
    // A run that would wait for this machine's held slot stops the test.
    sleep: () =>
      ++waits > 20
        ? Promise.reject(new Error("waited for this machine's slot"))
        : Promise.resolve(),
    exec: (cmd, _args, env) => {
      ran.push({ cmd, ...(env ? { env } : {}) });
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/repo",
  };
  return { d, out, err, ran };
}

const BASE = ["--base-url", "http://den.localhost:4100"];
const plain = (more: string[] = []) => [
  "run",
  "--kind",
  "browser",
  "--label",
  "e2e",
  "--pw-version",
  "1.48.0",
  ...more,
  "--",
  "npm",
  "test",
];

describe("default any: a plain browser run takes a free box", () => {
  it("with this machine's browser slot held, it gets the box, not a place in line here", async () => {
    const store = storeWith();
    holdHost(store);
    const t = deps(store);
    expect(await cmdGate(plain(BASE), t.d)).toBe(0);
    expect(t.err).not.toContain("gate: waited for this machine's slot");
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("b1");
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe("ws://b1.test:3000");
    expect(t.ran[0]!.env?.DEN_GATE_ALLOW).toBe("den.localhost:4100");
  });

  it("this machine free: it takes this machine first", async () => {
    const store = storeWith();
    const t = deps(store);
    expect(await cmdGate(plain(BASE), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBeUndefined();
  });

  it("the setting's default is any", () => {
    expect(storeWith().settings().browserBoxDefault).toBe("any");
  });
});

describe("browser_box_default local: today's behaviour", () => {
  it("a plain run waits for this machine, says nothing about boxes", async () => {
    const store = storeWith();
    store.writeSettings({ browser_box_default: "local" });
    const h = holdHost(store);
    const t = deps(store);
    expect(await cmdGate(plain(BASE), t.d)).toBe(1);
    expect(t.err).toContain("gate: waited for this machine's slot");
    expect(t.ran).toEqual([]);
    expect(t.err.some((l) => /stays on this machine/.test(l))).toBe(false);
    store.release(h.id);
  });

  it("only any or local is taken", () => {
    expect(checkGatePatch({ browser_box_default: "local" }).ok).toBe(true);
    const bad = checkGatePatch({ browser_box_default: "somewhere" });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.error).toMatch(/browser_box_default: .*any or local/);
  });
});

describe("runs that stay on this machine", () => {
  it("--box local stays, with no reason line", async () => {
    const store = storeWith();
    const t = deps(store);
    expect(await cmdGate(plain(["--box", "local", ...BASE]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err.some((l) => /stays on this machine/.test(l))).toBe(false);
  });

  it("--box <this machine's name> is local", async () => {
    const store = storeWith();
    const t = deps(store);
    const me = os.hostname().split(".")[0]!;
    expect(await cmdGate(plain(["--box", me, ...BASE]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
  });

  it("a host-only label pattern stays, saying which pattern", async () => {
    const store = storeWith();
    store.writeSettings({ browser_host_only: "label:*webkit*, layout" });
    const t = deps(store);
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--label",
          "hub-webkit-suite",
          ...BASE,
          "--",
          "npm",
          "test",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err).toContain(
      "gate: stays on this machine: hub-webkit-suite is host-only (browser_host_only label:*webkit*)",
    );
  });

  it("a host-only project stays", async () => {
    const store = storeWith();
    store.writeSettings({ browser_host_only: "repo" });
    const t = deps(store);
    expect(await cmdGate(plain(BASE), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err).toContain(
      "gate: stays on this machine: project repo is host-only (browser_host_only repo)",
    );
  });

  it("no --base-url: stays, in one line, and never fails for it", async () => {
    const store = storeWith();
    const t = deps(store);
    expect(await cmdGate(plain(), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    const why = t.err.filter((l) => /stays on this machine/.test(l));
    expect(why).toEqual([
      "gate: stays on this machine: no --base-url, so a test box can't reach the app",
    ]);
  });

  it("no box serves its Playwright version: stays, saying why", async () => {
    const store = storeWith([
      {
        name: "b1",
        playwright: "ws://b1.test:3000",
        playwright_version: "1.61.0",
      },
    ]);
    const t = deps(store);
    expect(await cmdGate(plain(BASE), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err).toContain(
      "gate: stays on this machine: no test box serves Playwright 1.48.0 (b1: client 1.48.0 ≠ server 1.61.0)",
    );
  });

  it("a run that starts its own browser container stays", async () => {
    const store = storeWith();
    const t = deps(store);
    expect(
      await cmdGate(plain(["--browser-endpoint=self", ...BASE]), t.d),
    ).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err).toContain(
      "gate: stays on this machine: it starts its own browser container",
    );
  });

  it("no test boxes set: nothing changes, nothing said", async () => {
    const store = storeWith([]);
    const t = deps(store);
    expect(await cmdGate(plain(), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    expect(t.err.some((l) => /stays on this machine/.test(l))).toBe(false);
  });
});

describe("status and the slot record show the machine", () => {
  it("a run on a box and one kept here, each with its machine", async () => {
    const store = storeWith();
    const kept = store.ask({
      kind: "browser",
      who: "t",
      label: "kept",
      pid: 1,
      estimateMin: 10,
      where: "local",
      hostWhy: "no --base-url, so a test box can't reach the app",
    });
    const t = deps(store);
    let lines: string[] = [];
    let view: ReturnType<typeof gateView> | undefined;
    t.d.exec = (cmd, _args, env) => {
      t.ran.push({ cmd, ...(env ? { env } : {}) });
      const s = deps(store);
      void cmdGate(["status"], s.d);
      lines = s.out;
      view = gateView(store, T0);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    };
    expect(await cmdGate(plain(BASE), t.d)).toBe(0);
    const onBox = store
      .events()
      .find((r) => r.event === "granted" && r.label === "e2e");
    expect(onBox?.box).toBe("b1");
    expect(lines.some((l) => /holds browser on box b1 .*"e2e"/.test(l))).toBe(
      true,
    );
    expect(
      lines.some((l) =>
        /holds browser on this machine .*"kept".*stays here: no --base-url/.test(
          l,
        ),
      ),
    ).toBe(true);
    const k = view!.slots.find((x) => x.id === kept.id)!;
    expect(k.machine).toBe("local");
    expect(k.hostWhy).toBe("no --base-url, so a test box can't reach the app");
    expect(view!.slots.find((x) => x.label === "e2e")!.machine).toBe("b1");
    const keptRow = store
      .events()
      .find((r) => r.event === "granted" && r.id === kept.id);
    expect(keptRow?.machine).toBe("local");
  });
});

describe("the two settings: gate settings and the Settings page", () => {
  it("gate settings sets and clears them; a bad value is refused", async () => {
    const store = storeWith();
    const t = deps(store);
    expect(
      await cmdGate(
        [
          "settings",
          "--browser-box-default",
          "local",
          "--browser-host-only",
          "den, label:layout*",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(store.settings().browserBoxDefault).toBe("local");
    expect(store.settings().browserHostOnly).toBe("den, label:layout*");
    expect(
      await cmdGate(
        ["settings", "--browser-box-default", "", "--browser-host-only", ""],
        t.d,
      ),
    ).toBe(0);
    expect(store.settings().browserBoxDefault).toBe("any");
    expect(store.settings().browserHostOnly).toBe("");
    expect(await cmdGate(["settings", "--browser-host-only", "a=b"], t.d)).toBe(
      2,
    );
  });

  it("have Settings rows in en, es and ja", () => {
    const pub = path.join(process.cwd(), "src/ui/server/public");
    const reg = fs.readFileSync(
      path.join(pub, "settings-registry.js"),
      "utf-8",
    );
    for (const id of ["gate_box_default", "gate_host_only"]) {
      expect(reg).toContain(`id: "server.${id}"`);
      for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
        const s = fs.readFileSync(path.join(pub, f), "utf-8");
        expect(s).toContain(`"set.server.${id}":`);
        expect(s).toContain(`"set.server.${id}.d":`);
      }
    }
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const s = fs.readFileSync(path.join(pub, f), "utf-8");
      expect(s).toContain(`"set.server.gate_box_default.any":`);
      expect(s).toContain(`"set.server.gate_box_default.local":`);
    }
  });
});
