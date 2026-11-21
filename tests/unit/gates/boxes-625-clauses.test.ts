/**
 * Issue 625, clauses 7 to 12 (from a real box run): one slot per box by
 * default, memory headroom, a remote browser kept off the host's live
 * services, *.localhost pinned to 127.0.0.1, a Playwright version match,
 * and a hard cap on the hold check. No ssh and no browser: the box check,
 * the child process and the browser context are stubs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import dns from "dns";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BOX_CHECK_CAP_MS,
  assign,
  boxSkipReason,
  checkBox,
  sftpProbe,
  type BoxProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import {
  allowedUrl,
  checkBaseUrl,
  guardContext,
  pinLoopbackNames,
} from "../../../src/shared/gates/pw-guard.js";
import {
  GATE_DEFAULTS,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0)) u();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-box7-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T06:00:00Z");

function storeWith(
  boxes: Partial<GateBox>[],
  answer: Awaited<ReturnType<BoxProbe>> = { state: "open" },
) {
  let now = T0;
  const probe: BoxProbe = () => Promise.resolve(answer);
  const store = new GateStore({
    dir: tmp(),
    alive: () => true,
    now: () => now,
    probe,
  });
  for (const b of boxes) store.setBox({ ssh: "ci@b.test", ...b });
  return { store, tick: (ms: number) => (now += ms) };
}

const ask = (store: GateStore, more: Record<string, unknown> = {}) =>
  store.ask({
    kind: "browser",
    who: "t",
    label: "e2e",
    pid: 1,
    estimateMin: 10,
    ...more,
  });

describe("clause 7: one heavy job per box by default", () => {
  it("a box set with no slot count has one; two runs never hold it at once", async () => {
    const c = checkBox({ name: "b1", ssh: "ci@b1.test" });
    expect(c.ok && c.box.browser_slots).toBe(1);
    const s = storeWith([{ name: "b1" }]);
    const a = ask(s.store, { where: "b1" });
    s.tick(1);
    const b = ask(s.store, { where: "b1" });
    await s.store.checkBoxes();
    await s.store.checkBoxes();
    const held = s.store.list().filter((e) => e.box === "b1");
    expect(held.map((e) => e.id)).toEqual([a.id]);
    expect(s.store.get(b.id)?.grantedAt).toBeUndefined();
  });
});

describe("clause 8: memory headroom", () => {
  it("no slot while the box reports less free memory than min_free_mem_mb; the queue says so", async () => {
    const s = storeWith([{ name: "b1" }], { state: "open", freeMemMb: 1500 });
    expect(s.store.boxes()[0]!.min_free_mem_mb).toBeUndefined();
    const a = ask(s.store, { where: "b1" });
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.grantedAt).toBeUndefined();
    const v = gateView(s.store).boxes[0]!;
    expect(v.state).toBe("low");
    expect(v.reason).toMatch(/box low on memory: 1500 MB free, needs 2048 MB/);
  });

  it("enough free memory: the slot is given; the minimum is a box setting", async () => {
    const s = storeWith([{ name: "b1", min_free_mem_mb: 1024 }], {
      state: "open",
      freeMemMb: 1500,
    });
    const a = ask(s.store, { where: "b1" });
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("b1");
  });
});

describe("clause 9: a remote browser never reaches the host's live services", () => {
  it("a box run's base URL is loopback with an explicit port other than 80 or 443", () => {
    expect(checkBaseUrl("http://127.0.0.1:4100")).toBeNull();
    expect(checkBaseUrl("http://den.localhost:4100/x")).toBeNull();
    expect(checkBaseUrl("http://localhost/")).toMatch(/port/);
    expect(checkBaseUrl("http://127.0.0.1:80")).toMatch(/port/);
    expect(checkBaseUrl("https://localhost:443")).toMatch(/port/);
    expect(checkBaseUrl("http://example.com:4100")).toMatch(/loopback/);
  });

  it("only the declared host:port loads", () => {
    const allow = ["den.localhost:4100"];
    expect(allowedUrl("http://den.localhost:4100/a", allow)).toBe(true);
    expect(allowedUrl("ws://den.localhost:4100/ws", allow)).toBe(true);
    expect(allowedUrl("data:text/plain,x", allow)).toBe(true);
    expect(allowedUrl("http://den.localhost/", allow)).toBe(false);
    expect(allowedUrl("http://127.0.0.1:80/", allow)).toBe(false);
    expect(allowedUrl("http://den.localhost:5000/", allow)).toBe(false);
  });

  it("a request to the host's :80 from a box run is blocked and reported", async () => {
    let handler: ((r: unknown) => Promise<void>) | undefined;
    const ctx = {
      route: (_p: string, h: (r: unknown) => Promise<void>) => {
        handler = h;
        return Promise.resolve();
      },
    };
    const blocked: string[] = [];
    await guardContext(ctx as never, ["127.0.0.1:4100"], (u) =>
      blocked.push(u),
    );
    const outcome: string[] = [];
    const route = (url: string) => ({
      request: () => ({ url: () => url }),
      continue: () => (outcome.push(`go ${url}`), Promise.resolve()),
      abort: () => (outcome.push(`stop ${url}`), Promise.resolve()),
    });
    await handler!(route("http://127.0.0.1:80/"));
    await handler!(route("http://127.0.0.1:4100/ok"));
    expect(outcome).toEqual([
      "stop http://127.0.0.1:80/",
      "go http://127.0.0.1:4100/ok",
    ]);
    expect(blocked).toEqual(["http://127.0.0.1:80/"]);
  });

  it("gate run refuses a box run without loopback base URLs, and hands the run its allowed hosts", async () => {
    const s = storeWith([{ name: "b1", playwright: "ws://b1.test:3000" }]);
    const t = deps(s.store);
    expect(
      await cmdGate(
        ["run", "--kind", "browser", "--box", "any", "--", "npm", "test"],
        t.d,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/--base-url/);
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--box",
          "any",
          "--base-url",
          "http://localhost/",
          "--",
          "npm",
          "test",
        ],
        t.d,
      ),
    ).toBe(2);
    ask(s.store); // this machine is busy: the run goes to the box
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--box",
          "any",
          "--base-url",
          "http://den.localhost:4100",
          "--",
          "npm",
          "test",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.ran.at(-1)!.env).toMatchObject({
      DEN_GATE_BOX: "b1",
      DEN_GATE_ALLOW: "den.localhost:4100",
    });
  });
});

describe("clause 10: *.localhost resolves to 127.0.0.1 on the client", () => {
  it("pins localhost names to IPv4 loopback, and never answers IPv6 for them", async () => {
    undo.push(pinLoopbackNames());
    const one = await dns.promises.lookup("den.localhost");
    expect(one).toEqual({ address: "127.0.0.1", family: 4 });
    const all = await dns.promises.lookup("a.b.localhost", { all: true });
    expect(all).toEqual([{ address: "127.0.0.1", family: 4 }]);
    const cb = await new Promise<unknown[]>((r) =>
      dns.lookup("localhost", (err, address, family) =>
        r([err, address, family]),
      ),
    );
    expect(cb).toEqual([null, "127.0.0.1", 4]);
    await expect(
      dns.promises.lookup("den.localhost", { family: 6 }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });
});

describe("clause 11: Playwright version match", () => {
  const entry = (id: string, pw?: string): GateEntry => ({
    id,
    kind: "browser",
    who: id,
    label: id,
    pid: 1,
    askedAt: new Date(T0).toISOString(),
    estimateMin: 10,
    where: "b1",
    ...(pw ? { pwVersion: pw } : {}),
  });
  const box = { name: "b1", slots: 1, open: true, version: "1.48.0" };

  it("a client that doesn't match the box's server never gets its slot", () => {
    expect(assign([entry("a", "1.49.0")], GATE_DEFAULTS, T0, [box])).toEqual(
      [],
    );
    expect(assign([entry("a", "1.48.0")], GATE_DEFAULTS, T0, [box])).toEqual([
      { id: "a", box: "b1" },
    ]);
  });

  it("the reason is client X ≠ server Y, in the queue", () => {
    expect(
      boxSkipReason({ pwVersion: "1.49.0" }, {
        name: "b1",
        playwright_version: "1.48.0",
      } as GateBox),
    ).toBe("client 1.49.0 ≠ server 1.48.0");
    const s = storeWith([{ name: "b1", playwright_version: "1.48.0" }]);
    ask(s.store, { where: "b1", pwVersion: "1.49.0" });
    const v = gateView(s.store).slots[0]!;
    expect(v.skips).toEqual([
      { box: "b1", reason: "client 1.49.0 ≠ server 1.48.0" },
    ]);
  });
});

describe("clause 12: the hold check is capped", () => {
  it("the check's timeout is at most 25 s", () => {
    expect(BOX_CHECK_CAP_MS).toBe(25_000);
    expect(checkGatePatch({ box_check_timeout_seconds: 26 }).ok).toBe(false);
    expect(checkGatePatch({ box_check_timeout_seconds: 25 }).ok).toBe(true);
  });

  it("an ssh that connects but stalls at the banner is unreachable, and its process is killed", async () => {
    const killed: string[] = [];
    const fakeSpawn = () => {
      const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
      k.stderr = new EventEmitter();
      k.stdin = { end: () => {} };
      k.kill = (s: string) => {
        killed.push(s);
        return true;
      };
      return k; // never closes: a banner that never comes
    };
    const probe = sftpProbe(fakeSpawn as never);
    const t0 = Date.now();
    const r = await probe(
      { name: "b1", ssh: "ci@b1.test", browser_slots: 1, hold_file: "h" },
      300,
    );
    expect(r.state).toBe("unreachable");
    expect(r.reason).toMatch(/no answer over ssh/);
    expect(killed).toEqual(["SIGKILL"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

function deps(store: GateStore) {
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
    cwd: "/x/repo",
  };
  return { d, out, err, ran };
}
