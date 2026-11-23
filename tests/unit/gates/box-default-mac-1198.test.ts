/**
 * Issue 1198: on a macOS host (the container rule on), a browser `gate run`
 * with no --box goes to a free test box that can serve it:
 *   - its environment's endpoint, when it is a loopback container, doesn't
 *     keep it here (a box replaces DEN_PW_WS; here it uses its own);
 *   - an endpoint on another host, or one given with --browser-endpoint,
 *     keeps its own browser, and status says why;
 *   - with no endpoint, it queues for the boxes only, never refused when a
 *     box can serve it;
 *   - with no --base-url, it may reach only the ports it opens itself
 *     (http://127.0.0.1:*, the box guard of issue 991).
 * No ssh and no browser: the box check and the command are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type BoxProbe } from "../../../src/shared/gates/boxes.js";
import { allowedUrl } from "../../../src/shared/gates/pw-guard.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T12:00:00Z");
const BOX_WS = "ws://b1.test:3000";

function macStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1198-"));
  tmps.push(dir);
  const probe: BoxProbe = () => Promise.resolve({ state: "open" });
  const store = new GateStore({
    platform: "darwin",
    dir,
    alive: () => true,
    now: () => T0,
    probe,
  });
  store.setBox({
    name: "b1",
    ssh: "ci@b1.test",
    playwright: BOX_WS,
    playwright_version: "1.48.0",
  });
  return store;
}

/** This machine's browser slot, held by another run (with its endpoint). */
function holdHost(store: GateStore) {
  const h = store.ask({
    kind: "browser",
    who: "other",
    label: "held",
    pid: 1,
    estimateMin: 10,
    browserEndpoint: "ws://127.0.0.1:3999/",
  });
  expect(h.grantedAt).toBeDefined();
  expect(h.box).toBeUndefined();
}

function deps(store: GateStore, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { env?: Record<string, string> }[] = [];
  let waits = 0;
  const d: GateDeps = {
    store,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => T0,
    // A run that waits for this machine's held slot: look at status once,
    // then stop the test.
    sleep: async () => {
      if (++waits === 1) await cmdGate(["status"], d);
      if (waits > 5) throw new Error("waited for this machine's slot");
    },
    exec: (_cmd, _args, e) => {
      ran.push(e ? { env: e } : {});
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

const run = (more: string[] = []) => [
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
const BASE = ["--base-url", "http://den.localhost:4100"];

describe("issue 1198: a macOS host's browser runs reach the test boxes", () => {
  it("a loopback container in DEN_PW_WS doesn't keep it here: it gets the free box", async () => {
    const store = macStore();
    holdHost(store);
    const t = deps(store, { DEN_PW_WS: "ws://127.0.0.1:3000/" });
    expect(await cmdGate(run(BASE), t.d)).toBe(0);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("b1");
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe(BOX_WS);
  });

  it("with this machine free, a loopback DEN_PW_WS run starts here with its own browser", async () => {
    const store = macStore();
    const t = deps(store, { DEN_PW_WS: "ws://127.0.0.1:3000/" });
    expect(await cmdGate(run(BASE), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_SLOT_BOX).toBe("local");
    // It keeps its own environment's endpoint: Den doesn't set one.
    expect(t.ran[0]!.env?.DEN_PW_WS).toBeUndefined();
  });

  it.each([
    [
      "an endpoint on another host in DEN_PW_WS",
      { DEN_PW_WS: "ws://bed-pw:3000" },
      [],
    ],
    [
      "--browser-endpoint <address>",
      {},
      ["--browser-endpoint", "ws://127.0.0.1:3000/"],
    ],
    ["--browser-endpoint=self", {}, ["--browser-endpoint=self"]],
  ] as [string, Record<string, string>, string[]][])(
    "%s keeps its own browser, and gate status says why",
    async (_what, env, flags) => {
      const store = macStore();
      holdHost(store);
      const t = deps(store, env);
      expect(await cmdGate(run([...BASE, ...flags]), t.d)).toBe(1);
      expect(t.err.join("\n")).toContain("waited for this machine's slot");
      expect(t.err.join("\n")).toMatch(
        /gate: stays on this machine: it (brings|starts) its own browser/,
      );
      expect(t.out.join("\n")).toMatch(
        /stays here: it (brings|starts) its own browser/,
      );
    },
  );

  it("no endpoint: it queues for the boxes only, not refused, and gets the box", async () => {
    const store = macStore();
    const t = deps(store);
    expect(await cmdGate(run(BASE), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("b1");
    expect(t.ran[0]!.env?.DEN_PW_WS).toBe(BOX_WS);
  });

  it("no endpoint and no box can serve it: still refused, with the container words", async () => {
    const store = macStore();
    const t = deps(store);
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--label",
          "e2e",
          "--pw-version",
          "9.9.9",
          ...BASE,
          "--",
          "x",
        ],
        t.d,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/must use a browser in a container/);
    expect(t.ran).toEqual([]);
  });
});

describe("issue 1198: no --base-url means only the ports the run opens", () => {
  it("a default pick with no --base-url gets the box, allowed 127.0.0.1:* only", async () => {
    const store = macStore();
    holdHost(store);
    const t = deps(store, { DEN_PW_WS: "ws://127.0.0.1:3000/" });
    expect(await cmdGate(run(), t.d)).toBe(0);
    expect(t.ran[0]!.env?.DEN_GATE_BOX).toBe("b1");
    expect(t.ran[0]!.env?.DEN_GATE_ALLOW).toBe("127.0.0.1:*");
  });

  it("in the guard: a port the run opened is reached; one it didn't, or 80/443, is refused", () => {
    const allow = ["127.0.0.1:*"];
    const own = { has: (p: number) => p === 41234 };
    expect(allowedUrl("http://127.0.0.1:41234/x", allow, own)).toBe(true);
    expect(allowedUrl("http://127.0.0.1:41235/x", allow, own)).toBe(false);
    expect(allowedUrl("http://127.0.0.1:80/", allow, { has: () => true })).toBe(
      false,
    );
    expect(
      allowedUrl("https://127.0.0.1:443/", allow, { has: () => true }),
    ).toBe(false);
    expect(allowedUrl("http://127.0.0.1:41234/x", allow)).toBe(false);
  });

  it("an explicit --box with no --base-url still says it needs one", async () => {
    const store = macStore();
    const t = deps(store);
    expect(await cmdGate(run(["--box", "b1"]), t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(/a box run needs --base-url/);
  });
});

describe("issue 1198: a CI runner's ask for any machine, with no browser of its own", () => {
  it("waits for a box and never takes this machine's free slot", () => {
    const store = macStore();
    const e = store.askRemote({
      kind: "browser",
      who: "ci",
      label: "e2e",
      estimateMin: 5,
      runner: "ci-linux",
      tokenId: "0123456789abcdef",
      where: "any",
      boxesOnly: true,
    });
    expect(e.boxesOnly).toBe(true);
    const now = store.get(e.id)!;
    // Granted only on a box (here, none is open yet), never this machine.
    expect(now.grantedAt === undefined || now.box !== undefined).toBe(true);
    expect(now.grantedAt).toBeUndefined();
  });
});
