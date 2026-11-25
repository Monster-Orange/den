/**
 * Issue 1527: a run with a visual-reference test (tagged
 * `@visual-reference`) goes only to a test box whose Chromium reports the
 * build its references were taken on: the one the run's pinned Playwright
 * installs. A named box with another build is refused before anything
 * starts, naming the box and both builds; with --box any, such a box is
 * skipped, saying why. Other runs go anywhere, as before. No ssh and no
 * browser: the box check, the build read and the command are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type BoxProbe } from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import {
  hasVisualTag,
  pinnedChromium,
  readBoxBrowsers,
  visualFilesInRun,
  type BrowserRead,
} from "../../../src/shared/gates/visual.js";
import {
  boxStatusLines,
  cmdGate,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1527-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-25T12:00:00Z");
/** The references' build (CI's, amd64) and an Apple-silicon box's. */
const REF = "149.0.7827.55";
const ARM = "149.0.7827.0";
const FONTS = "15px sans-serif=316.018";

/** A repo whose pinned Playwright installs Chromium REF, with tests. */
function repo(): string {
  const r = tmp();
  const pc = path.join(r, "node_modules", "playwright-core");
  fs.mkdirSync(pc, { recursive: true });
  fs.writeFileSync(
    path.join(pc, "browsers.json"),
    JSON.stringify({
      browsers: [
        { name: "chromium", revision: "1228", browserVersion: REF },
        { name: "webkit", revision: "2311", browserVersion: "26.5" },
      ],
    }),
  );
  const t = path.join(r, "tests", "ui");
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(
    path.join(t, "shell.browser.test.ts"),
    "/**\n * The shell against its stored reference.\n *\n * @visual-reference\n */\nexport {};\n",
  );
  fs.writeFileSync(
    path.join(t, "plain.browser.test.ts"),
    "/** A plain browser test. */\nexport {};\n",
  );
  return r;
}

function storeWith(dir = tmp()) {
  const probe: BoxProbe = () => Promise.resolve({ state: "open" });
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    now: () => T0,
    probe,
  });
  // The arm64 box first: a default pick would take it.
  for (const name of ["arm", "amd"])
    store.setBox({
      name,
      ssh: `ci@${name}.test`,
      playwright: `ws://${name}.test:3000`,
      playwright_version: "1.61.1",
    });
  return store;
}

/** This machine's browser slot, held by another run. */
const holdHost = (store: GateStore) =>
  store.ask({
    kind: "browser",
    who: "other",
    label: "held",
    pid: 1,
    estimateMin: 10,
  });

function deps(store: GateStore, cwd: string, read?: BrowserRead) {
  const err: string[] = [];
  const ran: { cmd: string; env?: Record<string, string> }[] = [];
  const reads: string[] = [];
  let waits = 0;
  const builds: Record<string, string> = {
    "ws://arm.test:3000": ARM,
    "ws://amd.test:3000": REF,
  };
  const d: GateDeps & { browserRead: BrowserRead } = {
    store,
    env: {},
    out: () => {},
    err: (l) => err.push(l),
    now: () => T0,
    sleep: () =>
      ++waits > 20 ? Promise.reject(new Error("waited")) : Promise.resolve(),
    exec: (cmd, _args, env) => {
      ran.push({ cmd, ...(env ? { env } : {}) });
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd,
    browserRead:
      read ??
      ((ws) => {
        reads.push(ws);
        const chromium = builds[ws];
        return chromium
          ? Promise.resolve({ chromium, fonts: FONTS })
          : Promise.reject(new Error(`no server at ${ws}`));
      }),
  };
  return { d, err, ran, reads };
}

const run = (file: string, more: string[] = []) => [
  "run",
  "--kind",
  "browser",
  "--label",
  "ui",
  "--pw-version",
  "1.61.1",
  "--base-url",
  "http://den.localhost:4100",
  ...more,
  "--",
  "npx",
  "jest",
  file,
];
const TAGGED = "tests/ui/shell.browser.test.ts";
const PLAIN = "tests/ui/plain.browser.test.ts";

describe("which tests are visual-reference tests", () => {
  it("the tag in a test's top comment marks it", () => {
    expect(hasVisualTag("/**\n * @visual-reference\n */")).toBe(true);
    expect(hasVisualTag("/** a plain test */")).toBe(false);
    // Only the head is read: a mention deep in the body isn't the tag.
    expect(hasVisualTag("x".repeat(5000) + "@visual-reference")).toBe(false);
  });

  it("a run's tagged files: named, under a named folder, or every one with --all-tests", () => {
    const r = repo();
    expect(visualFilesInRun(r, ["npx", "jest", TAGGED], false)).toEqual([
      TAGGED,
    ]);
    expect(visualFilesInRun(r, ["npx", "jest", PLAIN], false)).toEqual([]);
    expect(visualFilesInRun(r, ["npx", "jest", "tests/ui"], false)).toEqual([
      TAGGED,
    ]);
    expect(visualFilesInRun(r, ["npm", "test"], true)).toEqual([TAGGED]);
  });

  it("the references' build is the one the run's pinned Playwright installs", () => {
    const r = repo();
    expect(pinnedChromium(r)).toBe(REF);
    expect(pinnedChromium(path.join(r, "tests", "ui"))).toBe(REF);
    expect(pinnedChromium(tmp())).toBeUndefined();
  });
});

describe("a run with a visual-reference test goes only to a box with the references' build", () => {
  it("a named box with another build is refused before it starts, naming the box and both builds", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "arm"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      `box arm serves Chromium ${ARM}; the visual references need ${REF}`,
    );
    expect(t.ran).toEqual([]);
  });

  it("a named box with the references' build takes it", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("amd");
  });

  it("--box any skips the box with another build, saying why, and takes the one that matches", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "any"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("amd");
    expect(t.err.join("\n")).toMatch(
      `skips box arm serves Chromium ${ARM}; the visual references need ${REF}`,
    );
  });

  it("no box with the references' build: --box any is refused, never sent to another build", async () => {
    const r = repo();
    const store = storeWith();
    store.removeBox("amd");
    holdHost(store);
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "any"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      /no test box serves the visual references' Chromium build 149\.0\.7827\.55/,
    );
    expect(t.ran).toEqual([]);
  });

  it("a box whose build can't be read is never taken as a match", async () => {
    const r = repo();
    const t = deps(storeWith(), r, () =>
      Promise.reject(new Error("428 Precondition Required")),
    );
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      /box amd: its Chromium build couldn't be read \(428 Precondition Required\)/,
    );
    expect(t.ran).toEqual([]);
  });

  it("the builds read are kept for gate status, with the box's fonts", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    await cmdGate(run(TAGGED, ["--box", "any"]), t.d);
    const kept = readBoxBrowsers(store.dir);
    expect(kept.arm).toMatchObject({ chromium: ARM, fonts: FONTS });
    expect(kept.amd).toMatchObject({ chromium: REF, fonts: FONTS });
  });

  it("the default pick (no --box) skips the other build; with none matching it stays here, saying why", async () => {
    const r = repo();
    const store = storeWith();
    store.removeBox("amd");
    // This machine is busy: the default pick would take the arm box.
    holdHost(store);
    const t = deps(store, r);
    // It waits here instead (the stub ends the wait), never on the arm box.
    await cmdGate(run(TAGGED), t.d).catch(() => undefined);
    expect(t.ran).toEqual([]);
    expect(store.list().some((e) => e.box === "arm")).toBe(false);
    expect(t.err.join("\n")).toMatch(
      `gate: stays on this machine: no test box serves the visual references' Chromium build ${REF}`,
    );
  });

  it("gate status shows each box's Chromium build next to its Playwright version", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    await cmdGate(run(TAGGED, ["--box", "any"]), t.d);
    const lines = boxStatusLines(store, store.list()).join("\n");
    expect(lines).toMatch(`box arm: `);
    expect(lines).toMatch(`playwright 1.61.1, chromium ${ARM}`);
    expect(lines).toMatch(`playwright 1.61.1, chromium ${REF}`);
  });

  it("a run with no tagged test goes to any box, as before, and reads no build", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(PLAIN, ["--box", "arm"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("arm");
    expect(t.reads).toEqual([]);
  });
});
