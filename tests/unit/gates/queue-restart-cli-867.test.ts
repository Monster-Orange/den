/**
 * Issue 867, the command line: a `gate run` ended by a restart (SIGHUP or
 * SIGTERM while it waits) leaves its place kept; Ctrl-C (SIGINT) still
 * gives it back. Run again, it says it is back in its place, or what
 * became of the place. `gate status` shows a kept place, and the setting
 * is `gate settings --waiter-return-minutes N`.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const MIN = 60_000;

function deps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate867c-"));
  tmps.push(dir);
  const live = new Set<number>([1, 4242]);
  let now = Date.parse("2026-11-22T20:00:00Z");
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  let handler: ((s: NodeJS.Signals) => void) | undefined;
  const store = () =>
    new GateStore({
      platform: "linux",
      dir,
      now: () => now,
      alive: (p) => live.has(p),
    });
  const d: GateDeps = {
    store: store(),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    exit: (c) => {
      exits.push(c);
    },
    pid: 4242,
    cwd: "/x/some-repo",
    lang: "en",
  };
  return {
    d,
    out,
    err,
    exits,
    live,
    store,
    advance: (ms: number) => {
      now += ms;
    },
    signal: (s: NodeJS.Signals) => handler?.(s),
  };
}

type T = ReturnType<typeof deps>;

/** Someone else holds the browser slot, so our run waits. */
function held(t: T) {
  return t.d.store.ask({
    kind: "browser",
    who: "den · other · a person",
    label: "holder",
    pid: 1,
    estimateMin: 30,
  });
}

/** Our `gate run` waits, then gets `sig` (the restart). */
async function waitThen(t: T, sig: NodeJS.Signals) {
  t.d.sleep = () => {
    t.signal(sig);
    return Promise.resolve();
  };
  const code = await cmdGate(
    ["run", "--kind", "browser", "--label", "full check", "--", "x"],
    t.d,
  );
  t.d.sleep = () => Promise.resolve();
  return code;
}

const ours = (t: T) => t.d.store.list().find((e) => e.label === "full check");

describe("issue 867: gate run across a restart", () => {
  for (const [sig, code] of [
    ["SIGHUP", 129],
    ["SIGTERM", 143],
  ] as const)
    it(`${sig} while waiting keeps the place`, async () => {
      const t = deps();
      held(t);
      expect(await waitThen(t, sig)).toBe(code);
      expect(ours(t)).toBeDefined();
      expect(t.d.store.events().map((r) => r.event)).not.toContain("released");
    });

  it("SIGINT while waiting still gives the place back", async () => {
    const t = deps();
    held(t);
    expect(await waitThen(t, "SIGINT")).toBe(130);
    expect(ours(t)).toBeUndefined();
  });

  it("run again after a restart: back in its place, and it says so", async () => {
    const t = deps();
    const h = held(t);
    await waitThen(t, "SIGHUP");
    const first = ours(t)!;
    t.live.delete(4242); // the restart ended that gate run
    t.d.store = t.store();
    t.d.pid = 4343;
    t.live.add(4343);
    t.advance(2 * MIN);
    // The holder finishes while we wait again, so the run goes ahead.
    let n = 0;
    t.d.sleep = () => {
      if (++n === 1) t.d.store.release(h.id);
      return Promise.resolve();
    };
    expect(
      await cmdGate(
        ["run", "--kind", "browser", "--label", "full check", "--", "x"],
        t.d,
      ),
    ).toBe(0);
    expect(t.err).toContainEqual(
      expect.stringContaining(`gate: back in your place (${first.id})`),
    );
  });

  it("gate status shows a kept place and until when", async () => {
    const t = deps();
    held(t);
    await waitThen(t, "SIGTERM");
    t.live.delete(4242);
    t.d.store = t.store();
    await cmdGate(["status"], t.d);
    const line = t.out.find((l) => l.includes('"full check"'))!;
    expect(line).toMatch(/run gone, place kept until \d/);
  });

  it("run again after the place was let go: it says what became of it", async () => {
    const t = deps();
    held(t);
    await waitThen(t, "SIGTERM");
    t.live.delete(4242);
    t.d.store = t.store();
    t.d.store.list();
    t.advance(11 * MIN);
    t.d.store.list();
    t.d.pid = 4444;
    t.live.add(4444);
    t.err.length = 0;
    await waitThen(t, "SIGINT");
    expect(t.err).toContainEqual(
      expect.stringMatching(
        /gate: your earlier place \(asked .+?\) was let go at .+: its run was gone for 10 min/,
      ),
    );
  });

  it("gate settings --waiter-return-minutes sets it", async () => {
    const t = deps();
    expect(
      await cmdGate(["settings", "--waiter-return-minutes", "30"], t.d),
    ).toBe(0);
    expect(t.d.store.settings().waiterReturnMinutes).toBe(30);
  });
});
