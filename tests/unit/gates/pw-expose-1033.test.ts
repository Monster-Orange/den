/**
 * Issue 1033: a box run reaches this machine's ports only when its client
 * connects with exposeNetwork "<loopback>". The gate hands a box run
 * DEN_PW_EXPOSE=<loopback> beside DEN_PW_WS (never on this machine), and
 * pw-guard's connect reads it, so a client that uses pw-guard needs no
 * code of its own. A box run that connects without it is told once.
 * No ssh and no browser: the box check, the command and the browser type
 * are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boxEnv, type BoxProbe } from "../../../src/shared/gates/boxes.js";
import {
  connectGuarded,
  connectOptions,
  warnBoxExpose,
} from "../../../src/shared/gates/pw-guard.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T13:00:00Z");

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1033x-"));
  tmps.push(dir);
  const probe: BoxProbe = () => Promise.resolve({ state: "open" });
  const s = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    now: () => T0,
    probe,
  });
  s.setBox({
    name: "b1",
    playwright: "ws://b1.test:3000",
    playwright_version: "1.48.0",
  });
  return s;
}

function deps(s: GateStore) {
  const err: string[] = [];
  const ran: Record<string, string>[] = [];
  const d: GateDeps = {
    store: s,
    env: {},
    out: () => {},
    err: (l) => err.push(l),
    now: () => T0,
    sleep: () => Promise.resolve(),
    exec: (_c, _a, env) => {
      ran.push(env ?? {});
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/repo",
  };
  return { d, err, ran };
}

const run = (more: string[]) => [
  "run",
  "--kind",
  "browser",
  "--pw-version",
  "1.48.0",
  "--base-url",
  "http://127.0.0.1:*",
  ...more,
  "--",
  "npm",
  "test",
];

describe("the gate hands a box run DEN_PW_EXPOSE", () => {
  it("an explicit --box: <loopback> beside DEN_PW_WS", async () => {
    const t = deps(store());
    expect(await cmdGate(run(["--box", "b1"]), t.d)).toBe(0);
    expect(t.ran[0]!.DEN_PW_WS).toBe("ws://b1.test:3000");
    expect(t.ran[0]!.DEN_PW_EXPOSE).toBe("<loopback>");
  });

  it("a default pick onto a box: the same", async () => {
    const s = store();
    s.ask({ kind: "browser", who: "o", label: "h", pid: 1, estimateMin: 9 });
    const t = deps(s);
    expect(await cmdGate(run([]), t.d)).toBe(0);
    expect(t.ran[0]!.DEN_GATE_BOX).toBe("b1");
    expect(t.ran[0]!.DEN_PW_EXPOSE).toBe("<loopback>");
  });

  it("on this machine: nothing new", async () => {
    const t = deps(store());
    expect(await cmdGate(run(["--box", "local"]), t.d)).toBe(0);
    expect(t.ran[0]!.DEN_PW_EXPOSE).toBeUndefined();
  });

  it("boxEnv says it whenever it gives DEN_PW_WS", () => {
    const b = {
      name: "b1",
      browser_slots: 1,
      playwright: "ws://b1.test:3000",
    };
    expect(boxEnv(b).DEN_PW_EXPOSE).toBe("<loopback>");
    expect(
      boxEnv({ name: "b2", browser_slots: 1, ssh: "ci@b2.test" }).DEN_PW_EXPOSE,
    ).toBeUndefined();
  });
});

describe("pw-guard's connect reads it", () => {
  const BOX = {
    DEN_GATE_SLOT_BOX: "b1",
    DEN_PW_EXPOSE: "<loopback>",
  } as NodeJS.ProcessEnv;

  it("connectOptions: DEN_PW_EXPOSE, unless the caller gave its own", () => {
    expect(connectOptions(BOX)).toEqual({ exposeNetwork: "<loopback>" });
    expect(
      connectOptions<{ timeout?: number; exposeNetwork?: string }>(BOX, {
        timeout: 5,
      }),
    ).toEqual({
      timeout: 5,
      exposeNetwork: "<loopback>",
    });
    expect(connectOptions(BOX, { exposeNetwork: "*" })).toEqual({
      exposeNetwork: "*",
    });
    expect(connectOptions({})).toEqual({});
  });

  it("connectGuarded connects with it, and says nothing", async () => {
    const seen: unknown[] = [];
    const said: string[] = [];
    // Issue 1205: the browser it gives back is guarded (connect-guarded-1205).
    const browser = { newContext: async () => ({ route: async () => {} }) };
    const type = {
      connect: (ws: string, o: unknown) => {
        seen.push([ws, o]);
        return Promise.resolve(browser);
      },
    };
    expect(
      await connectGuarded(type, "ws://b1.test:3000", {}, BOX, (l) =>
        said.push(l),
      ),
    ).toBe(browser);
    expect(seen).toEqual([
      ["ws://b1.test:3000", { exposeNetwork: "<loopback>" }],
    ]);
    expect(said).toEqual([]);
  });
});

describe("a box run that connects without it is told once", () => {
  const LINE =
    "box run without exposeNetwork <loopback>: pages on this machine will be refused; pass DEN_PW_EXPOSE to connect()";

  it("one line, once per process", () => {
    const said: string[] = [];
    const env = { DEN_GATE_SLOT_BOX: "b9" } as NodeJS.ProcessEnv;
    expect(warnBoxExpose(env, {}, (l) => said.push(l))).toBe(true);
    expect(warnBoxExpose(env, {}, (l) => said.push(l))).toBe(false);
    expect(said).toEqual([LINE]);
  });

  it("never on this machine, nor with <loopback> or * exposed", () => {
    const said: string[] = [];
    const say = (l: string) => said.push(l);
    expect(warnBoxExpose({ DEN_GATE_SLOT_BOX: "local" }, {}, say)).toBe(false);
    expect(warnBoxExpose({}, {}, say)).toBe(false);
    const box = { DEN_GATE_SLOT_BOX: "b8" } as NodeJS.ProcessEnv;
    expect(
      warnBoxExpose(box, { exposeNetwork: "<loopback>,10.0.0.1" }, say),
    ).toBe(false);
    expect(warnBoxExpose(box, { exposeNetwork: "*" }, say)).toBe(false);
    expect(said).toEqual([]);
  });
});
