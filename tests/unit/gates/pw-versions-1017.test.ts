/**
 * Issue 1017: a test box serves several Playwright versions, version → ws
 * address, and a run gets the endpoint whose version matches its own. The
 * run's version comes from --pw-version, else from the nearest package.json
 * at or below its folder that depends on Playwright. A box with no match is
 * skipped, saying why; a box with one endpoint works as before. The slot
 * count stays the box's own, whatever version a run takes.
 * No ssh and no browser: the box check and the command are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assign,
  boxEnv,
  boxSkipReason,
  checkBox,
  type BoxProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import {
  boxStatusLines,
  cmdGate,
  playwrightVersion,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1017-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-22T06:00:00Z");
const TWO = { "1.61": "ws://b1.test:3931", "1.63": "ws://b1.test:3932" };

function storeWith(boxes: Record<string, unknown>[]) {
  const probe: BoxProbe = () => Promise.resolve({ state: "open" });
  const store = new GateStore({
    platform: "linux",
    dir: tmp(),
    alive: () => true,
    now: () => T0,
    probe,
  });
  for (const b of boxes) store.setBox({ ssh: "ci@b1.test", ...b });
  return store;
}

function deps(store: GateStore, cwd = "/x/repo") {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { cmd: string; env?: Record<string, string> }[] = [];
  const d: GateDeps = {
    store,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => T0,
    sleep: () => Promise.resolve(),
    exec: (cmd, _args, env) => {
      ran.push({ cmd, ...(env ? { env } : {}) });
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd,
  };
  return { d, out, err, ran };
}

const boxRun = (more: string[] = []) => [
  "run",
  "--kind",
  "browser",
  "--box",
  "b1",
  "--base-url",
  "http://den.localhost:4100",
  ...more,
  "--",
  "npm",
  "test",
];

describe("a box lists several Playwright endpoints", () => {
  it("version → ws address, checked like the one address", () => {
    const c = checkBox({ name: "b1", ssh: "ci@b1", playwright_endpoints: TWO });
    expect(c).toEqual({
      ok: true,
      box: {
        name: "b1",
        ssh: "ci@b1",
        browser_slots: 1,
        playwright_endpoints: TWO,
      },
    });
    for (const bad of [
      { "1.61": "http://b1:3931" },
      { "1.61": "ws://u:p@b1:3931" },
      { latest: "ws://b1:3931" },
      {},
    ])
      expect(
        checkBox({ name: "b1", ssh: "ci@b1", playwright_endpoints: bad }).ok,
      ).toBe(false);
    // Both ways at once is refused: one box, one way to say it.
    expect(
      checkBox({
        name: "b1",
        playwright: "ws://b1:3000",
        playwright_endpoints: TWO,
      }).ok,
    ).toBe(false);
    // Endpoints alone are a way to reach the box.
    expect(checkBox({ name: "b1", playwright_endpoints: TWO }).ok).toBe(true);
  });

  it("gate box add --pw <version>=<ws>, repeatable", async () => {
    const store = storeWith([]);
    const t = deps(store);
    expect(
      await cmdGate(
        [
          "box",
          "add",
          "b1",
          "--ssh",
          "ci@b1.test",
          "--pw",
          "1.61=ws://b1.test:3931",
          "--pw",
          "1.63=ws://b1.test:3932",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(store.boxes()[0]!.playwright_endpoints).toEqual(TWO);
    expect(await cmdGate(["box", "add", "b2", "--pw", "1.61"], t.d)).toBe(2);
  });
});

describe("the gate picks the endpoint whose version matches the run's", () => {
  it("a run with 1.63, a box with 1.61 and 1.63: gets the 1.63 endpoint", async () => {
    const store = storeWith([{ name: "b1", playwright_endpoints: TWO }]);
    const t = deps(store);
    expect(await cmdGate(boxRun(["--pw-version", "1.63.0"]), t.d)).toBe(0);
    expect(t.ran[0]!.env).toMatchObject({
      DEN_GATE_BOX: "b1",
      DEN_PW_WS: "ws://b1.test:3932",
    });
  });

  it("boxEnv picks by version; 1.61 matches 1.61.x", () => {
    const b = { name: "b1", browser_slots: 1, playwright_endpoints: TWO };
    expect(boxEnv(b, "1.61.2").DEN_PW_WS).toBe("ws://b1.test:3931");
    expect(boxEnv(b, "1.63").DEN_PW_WS).toBe("ws://b1.test:3932");
    expect(boxSkipReason({ pwVersion: "1.61.2" }, b)).toBe("");
  });

  it("the slot stays the box's: two versions never hold one slot twice", () => {
    const e = (id: string, v: string): GateEntry => ({
      id,
      kind: "browser",
      who: id,
      label: id,
      pid: 1,
      askedAt: new Date(T0).toISOString(),
      estimateMin: 10,
      where: "b1",
      pwVersion: v,
    });
    const cap = {
      name: "b1",
      slots: 1,
      open: true,
      versions: ["1.61", "1.63"],
    };
    expect(
      assign([e("a", "1.61.0"), e("b", "1.63.0")], GATE_DEFAULTS, T0, [cap]),
    ).toEqual([{ id: "a", box: "b1" }]);
  });
});

describe("the run's version, found where Playwright is", () => {
  it("a repo with Playwright only in web/: the version is found there", () => {
    const repo = tmp();
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "r", dependencies: { express: "^4" } }),
    );
    const web = path.join(repo, "web");
    fs.mkdirSync(path.join(web, "node_modules", "@playwright", "test"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "^1.63.0" } }),
    );
    fs.writeFileSync(
      path.join(web, "node_modules", "@playwright", "test", "package.json"),
      JSON.stringify({ version: "1.63.1" }),
    );
    expect(playwrightVersion(repo)).toBe("1.63.1");
  });

  it("installed higher up (hoisted): found from the folder below", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    const web = path.join(repo, "packages", "web");
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({ devDependencies: { playwright: "~1.61.0" } }),
    );
    fs.mkdirSync(path.join(repo, "node_modules", "playwright"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, "node_modules", "playwright", "package.json"),
      JSON.stringify({ version: "1.61.4" }),
    );
    expect(playwrightVersion(repo)).toBe("1.61.4");
  });

  it("a range alone is unknown: never read as a version", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "^1.48.0" } }),
    );
    const web = path.join(repo, "web");
    fs.mkdirSync(web);
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "1.61.0" } }),
    );
    expect(playwrightVersion(repo)).toBeUndefined();
    expect(playwrightVersion(web)).toBeUndefined();
  });

  it("a run in a workspace subfolder, Playwright installed at the repo root: its exact version, and that endpoint", async () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    fs.mkdirSync(path.join(repo, "node_modules", "@playwright", "test"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, "node_modules", "@playwright", "test", "package.json"),
      JSON.stringify({ version: "1.63.2" }),
    );
    const app = path.join(repo, "packages", "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "^1.48.0" } }),
    );
    expect(playwrightVersion(app)).toBe("1.63.2");
    const store = storeWith([{ name: "b1", playwright_endpoints: TWO }]);
    const t = deps(store, app);
    expect(await cmdGate(boxRun(), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe("ws://b1.test:3932");
  });

  it("never looks above the repo's top folder", () => {
    const outer = tmp();
    fs.mkdirSync(path.join(outer, "node_modules", "playwright"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(outer, "node_modules", "playwright", "package.json"),
      JSON.stringify({ version: "1.40.0" }),
    );
    const repo = path.join(outer, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(playwrightVersion(path.join(repo))).toBeUndefined();
  });
});

describe("an unknown version", () => {
  it("on a box with one address: runs as before, no version check", async () => {
    const store = storeWith([
      {
        name: "b1",
        playwright: "ws://b1.test:3000",
        playwright_version: "1.48.0",
      },
    ]);
    const t = deps(store, tmp());
    expect(await cmdGate(boxRun(), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe("ws://b1.test:3000");
  });

  it("on a box with several versions: refused in one plain line", async () => {
    const store = storeWith([{ name: "b1", playwright_endpoints: TWO }]);
    const t = deps(store, tmp());
    expect(await cmdGate(boxRun(), t.d)).toBe(2);
    expect(t.ran).toEqual([]);
    expect(t.err).toEqual([
      "gate: box b1 serves Playwright 1.61, 1.63 and this run's Playwright version is unknown: pass --pw-version",
    ]);
    expect(store.list()).toEqual([]);
  });

  it("--box any: a box with several versions is skipped, saying so", () => {
    const store = storeWith([{ name: "b1", playwright_endpoints: TWO }]);
    store.ask({
      kind: "browser",
      who: "t",
      label: "e2e",
      pid: 1,
      estimateMin: 10,
      where: "b1",
    });
    expect(gateView(store).slots[0]!.skips).toEqual([
      {
        box: "b1",
        reason: "Playwright version unknown: pass --pw-version",
      },
    ]);
    expect(
      boxEnv({ name: "b1", browser_slots: 1, playwright_endpoints: TWO })
        .DEN_PW_WS,
    ).toBeUndefined();
  });
});

describe("no matching version: skipped, with the reason", () => {
  it("the queue says which versions the box serves", () => {
    const store = storeWith([{ name: "b1", playwright_endpoints: TWO }]);
    store.ask({
      kind: "browser",
      who: "t",
      label: "e2e",
      pid: 1,
      estimateMin: 10,
      where: "b1",
      pwVersion: "1.62.0",
    });
    expect(gateView(store).slots[0]!.skips).toEqual([
      { box: "b1", reason: "client 1.62.0: box serves 1.61, 1.63" },
    ]);
    expect(store.list()[0]!.grantedAt).toBeUndefined();
  });
});

describe("gate status lists each box's versions", () => {
  it("one line per box, with its versions", () => {
    const store = storeWith([
      { name: "b1", playwright_endpoints: TWO },
      {
        name: "b2",
        playwright: "ws://b2.test:3000",
        playwright_version: "1.48.0",
      },
      { name: "b3" },
    ]);
    expect(boxStatusLines(store, [])).toEqual([
      "box b1: 0 of 1 browser slots held, not checked yet, playwright 1.61, 1.63",
      "box b2: 0 of 1 browser slots held, not checked yet, playwright 1.48.0",
      "box b3: 0 of 1 browser slots held, not checked yet",
    ]);
  });
});

describe("a one-endpoint box: unchanged", () => {
  it("a settings.json written before keeps reading, checking and running the same", async () => {
    const dir = tmp();
    const legacy: GateBox = {
      name: "b1",
      ssh: "ci@b1.test",
      playwright: "ws://b1.test:3000",
      playwright_version: "1.48.0",
      browser_slots: 1,
    };
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ boxes: [legacy] }),
    );
    const store = new GateStore({
      platform: "linux",
      dir,
      alive: () => true,
      now: () => T0,
      probe: () => Promise.resolve({ state: "open" }),
    });
    expect(store.boxes()).toEqual([legacy]);
    expect(boxEnv(legacy, "1.48.0").DEN_PW_WS).toBe("ws://b1.test:3000");
    expect(boxEnv(legacy).DEN_PW_WS).toBe("ws://b1.test:3000");
    expect(boxSkipReason({ pwVersion: "1.49.0" }, legacy)).toBe(
      "client 1.49.0 ≠ server 1.48.0",
    );
    const t = deps(store);
    expect(await cmdGate(boxRun(["--pw-version", "1.48.0"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe("ws://b1.test:3000");
    // Nothing rewrote the file.
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8")),
    ).toEqual({ boxes: [legacy] });
  });
});
