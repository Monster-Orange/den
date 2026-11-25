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
  envMismatch,
  hasVisualTag,
  pinnedChromium,
  readBoxBrowsers,
  visualFilesInRun,
  visualRecordOf,
  type BrowserRead,
  type VisualEnv,
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
const FONTS = { "400 14px sans-serif": 442.016, "400 14px monospace": 469 };
/** The references' record: CI's amd64 browser. */
const REF_ENV: VisualEnv = {
  platform: "linux/amd64",
  chromium: REF,
  fonts: FONTS,
};
/** What each box's server says of its browser. */
const ENVS: Record<string, VisualEnv> = {
  // An Apple-silicon box: the image's arm64 build.
  "ws://arm.test:3000": {
    platform: "linux/arm64",
    chromium: ARM,
    fonts: FONTS,
  },
  // CI's browser.
  "ws://amd.test:3000": REF_ENV,
};

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
    "/**\n * The shell against its stored reference.\n *\n * @visual-reference tests/ui/visual-env.json\n */\nexport {};\n",
  );
  fs.writeFileSync(path.join(t, "visual-env.json"), JSON.stringify(REF_ENV));
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
        const env = ENVS[ws];
        return env
          ? Promise.resolve(env)
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
  it("the tag in a test's top comment marks it, and names its references' record", () => {
    const tag = "/**\n * @visual-reference tests/ui/visual-env.json\n */";
    expect(hasVisualTag(tag)).toBe(true);
    expect(visualRecordOf(tag)).toBe("tests/ui/visual-env.json");
    expect(hasVisualTag("/** a plain test */")).toBe(false);
    expect(visualRecordOf("/** @visual-reference */")).toBeUndefined();
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

  it("the build the run's pinned Playwright installs is read from browsers.json", () => {
    const r = repo();
    expect(pinnedChromium(r)).toBe(REF);
    expect(pinnedChromium(path.join(r, "tests", "ui"))).toBe(REF);
    expect(pinnedChromium(tmp())).toBeUndefined();
  });
});

describe("a box matches the record only on platform, build and every font", () => {
  it("the same browser matches", () => {
    expect(envMismatch(REF_ENV, { ...REF_ENV })).toBe("");
  });

  it("same version, wrong architecture: no match", () => {
    expect(envMismatch(REF_ENV, { ...REF_ENV, platform: "linux/arm64" })).toBe(
      "is linux/arm64; the references were taken on linux/amd64",
    );
  });

  it("same architecture, wrong fonts: no match", () => {
    expect(
      envMismatch(REF_ENV, {
        ...REF_ENV,
        fonts: { ...FONTS, "400 14px sans-serif": 441.5 },
      }),
    ).toBe(
      "draws 400 14px sans-serif 441.5 px wide; the references 442.016 px",
    );
    const { ["400 14px monospace"]: _gone, ...fewer } = FONTS;
    expect(envMismatch(REF_ENV, { ...REF_ENV, fonts: fewer })).toBe(
      "draws 400 14px monospace not at all; the references 469 px",
    );
  });

  it("another build: no match", () => {
    expect(envMismatch(REF_ENV, { ...REF_ENV, chromium: ARM })).toBe(
      `serves Chromium ${ARM}; the references were taken on ${REF}`,
    );
  });
});

/** The two boxes plus one more, whose server says `env`. */
function withThird(env: VisualEnv) {
  const store = storeWith();
  store.setBox({
    name: "odd",
    ssh: "ci@odd.test",
    playwright: "ws://odd.test:3000",
    playwright_version: "1.61.1",
  });
  ENVS["ws://odd.test:3000"] = env;
  return store;
}

describe("a run with a visual-reference test goes only to a box matching its record", () => {
  it("a named box on another platform and build is refused before it starts, saying how it differs", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "arm"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "box arm is linux/arm64; the references were taken on linux/amd64 (tests/ui/visual-env.json)",
    );
    expect(t.ran).toEqual([]);
  });

  it("same version, wrong architecture: a named box is refused", async () => {
    const r = repo();
    const store = withThird({ ...REF_ENV, platform: "linux/arm64" });
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "odd"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "box odd is linux/arm64; the references were taken on linux/amd64",
    );
    expect(t.ran).toEqual([]);
  });

  it("same architecture, wrong fonts: a named box is refused", async () => {
    const r = repo();
    const store = withThird({
      ...REF_ENV,
      fonts: { ...FONTS, "400 14px monospace": 470.25 },
    });
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "odd"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "box odd draws 400 14px monospace 470.25 px wide; the references 469 px",
    );
    expect(t.ran).toEqual([]);
  });

  it("a named box matching the record takes it", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("amd");
  });

  it("--box any skips a box that differs, saying why, and takes the one that matches", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "any"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("amd");
    expect(t.err.join("\n")).toMatch(
      "gate: skips box arm is linux/arm64; the references were taken on linux/amd64",
    );
  });

  it("no box matching: --box any is refused, never sent to another browser", async () => {
    const r = repo();
    const store = storeWith();
    store.removeBox("amd");
    holdHost(store);
    const t = deps(store, r);
    expect(await cmdGate(run(TAGGED, ["--box", "any"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "no test box serves the browser the visual references were taken on",
    );
    expect(t.ran).toEqual([]);
  });

  it("a box whose browser can't be read is never taken as a match", async () => {
    const r = repo();
    const t = deps(storeWith(), r, () =>
      Promise.reject(new Error("428 Precondition Required")),
    );
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "box amd: its browser couldn't be read (428 Precondition Required)",
    );
    expect(t.ran).toEqual([]);
  });

  it("a box that connects and then stalls: the whole read has one deadline, then it doesn't match", async () => {
    const r = repo();
    const store = storeWith();
    store.writeSettings({ box_check_timeout_seconds: 1 });
    // Connected, then never answers (newPage, the probe: nothing settles).
    const t = deps(store, r, () => new Promise<VisualEnv>(() => {}));
    const started = Date.now();
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.err.join("\n")).toMatch(
      "box amd: its browser couldn't be read (no answer in 1 s)",
    );
    expect(t.ran).toEqual([]);
  }, 10000);

  it("a tag that names no record, or a record that isn't there: no box matches", async () => {
    const r = repo();
    const f = path.join(r, TAGGED);
    fs.writeFileSync(f, "/**\n * @visual-reference\n */\nexport {};\n");
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(
      "its @visual-reference tag names no record",
    );
    fs.writeFileSync(
      f,
      "/**\n * @visual-reference tests/ui/gone.json\n */\nexport {};\n",
    );
    const t2 = deps(storeWith(), r);
    expect(await cmdGate(run(TAGGED, ["--box", "amd"]), t2.d)).toBe(2);
    expect(t2.err.join("\n")).toMatch("no reference record at");
  });

  it("the reads are kept for gate status, with each box's platform and fonts", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    await cmdGate(run(TAGGED, ["--box", "any"]), t.d);
    const kept = readBoxBrowsers(store.dir);
    expect(kept.arm).toMatchObject({
      platform: "linux/arm64",
      chromium: ARM,
      fonts: FONTS,
    });
    expect(kept.amd).toMatchObject({
      platform: "linux/amd64",
      chromium: REF,
      fonts: FONTS,
    });
  });

  it("the default pick (no --box) skips a box that differs; with none matching it stays here, saying why", async () => {
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
      "gate: stays on this machine: no test box serves the browser the visual references were taken on",
    );
  });

  it("gate status shows each box's Chromium build and platform next to its Playwright version", async () => {
    const r = repo();
    const store = storeWith();
    holdHost(store);
    const t = deps(store, r);
    await cmdGate(run(TAGGED, ["--box", "any"]), t.d);
    const lines = boxStatusLines(store, store.list()).join("\n");
    expect(lines).toMatch(`playwright 1.61.1, chromium ${ARM} linux/arm64`);
    expect(lines).toMatch(`playwright 1.61.1, chromium ${REF} linux/amd64`);
  });

  it("a run with no tagged test goes to any box, as before, and reads no browser", async () => {
    const r = repo();
    const t = deps(storeWith(), r);
    expect(await cmdGate(run(PLAIN, ["--box", "arm"]), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("arm");
    expect(t.reads).toEqual([]);
  });
});
