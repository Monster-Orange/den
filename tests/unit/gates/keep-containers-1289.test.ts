/**
 * Issue 1289: a throwaway container kept per checkout (a test database set
 * up once, slow to make) is stopped, never removed, when its checkout's
 * runs end.
 *
 *  1. den.ephemeral=stop: stopped, never removed; den.ephemeral=1 keeps the
 *     remove from issue 1263.
 *  2. Owned by a checkout, not a run: `gate run` gives DEN_GATE_CHECKOUT
 *     and records it on its slot; the container carries den.gate.checkout.
 *     It is stopped only when running and no live slot has its checkout.
 *  3. The store guard; no checkout label: never stopped.
 *  4. An already-stopped container: no stop.
 *  5. Doctor counts stopped-and-kept ones apart, and warns about a running
 *     one whose checkout has no live run.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CHECKOUT_LABEL,
  EPHEMERAL_LABEL,
  RUN_LABEL,
  STORE_LABEL,
  checkoutOf,
  checkoutTag,
  cleanRun,
  ephemeralLabels,
  storeTag,
  sweepThrowaway,
  type Docker,
} from "../../../src/shared/gates/ephemeral.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { throwawayLines } from "../../../src/ui/cli/doctor-throwaway.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-1289-"));
  tmps.push(d);
  return d;
};

interface Box {
  id: string;
  image: string;
  state: "running" | "exited";
  labels: Record<string, string>;
}

/** A fake docker: ps applies label filters (key or key=value); stop; rm -f. */
function world(boxes: Box[]) {
  const calls: string[][] = [];
  const docker: Docker = async (args) => {
    calls.push(args);
    if (args[0] === "ps") {
      const want = args
        .flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : []))
        .map((f) => f.replace(/^label=/, "").split("="));
      const hit = boxes.filter((b) =>
        want.every(([k, v]) =>
          v === undefined ? k! in b.labels : b.labels[k!] === v,
        ),
      );
      return {
        code: 0,
        out: hit
          .map((b) =>
            [
              b.id,
              b.image,
              b.labels[RUN_LABEL] ?? "",
              "",
              b.labels[STORE_LABEL] ?? "",
              b.labels[EPHEMERAL_LABEL] ?? "",
              b.state,
              b.labels[CHECKOUT_LABEL] ?? "",
            ].join("\t"),
          )
          .join("\n"),
      };
    }
    if (args[0] === "stop") {
      for (const id of args.slice(1).filter((a) => !a.startsWith("-"))) {
        const b = boxes.find((x) => x.id === id);
        if (b) b.state = "exited";
      }
      return { code: 0, out: "" };
    }
    if (args[0] === "rm") {
      for (const id of args.slice(1).filter((a) => !a.startsWith("-"))) {
        const i = boxes.findIndex((b) => b.id === id);
        if (i >= 0) boxes.splice(i, 1);
      }
      return { code: 0, out: "" };
    }
    return { code: 1, out: "" };
  };
  return { boxes, calls, docker };
}

/** A store in use (its slots folder made). */
const newStore = (alive: (pid: number) => boolean = () => true) => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
  return new GateStore({ platform: "linux", dir, alive });
};

/** A kept container for `checkout` (a tag), made by run `run`. */
const kept = (
  id: string,
  store: GateStore,
  checkout: string | null,
  state: Box["state"] = "running",
  run = "cpu-0000000001",
): Box => ({
  id,
  image: "postgres:16",
  state,
  labels: {
    [EPHEMERAL_LABEL]: "stop",
    [RUN_LABEL]: run,
    [STORE_LABEL]: storeTag(store.dir),
    ...(checkout ? { [CHECKOUT_LABEL]: checkout } : {}),
  },
});

const T0 = Date.parse("2026-11-22T22:00:00Z");
async function twice(s: GateStore, docker: Docker) {
  const seen = new Map<string, number>();
  await sweepThrowaway(s, docker, seen, T0);
  return sweepThrowaway(s, docker, seen, T0 + 61_000);
}

describe("issue 1289 (1, 2): labels and the checkout", () => {
  it("a kept container is labelled stop, with its store and checkout", () => {
    const dir = tmp();
    expect(
      ephemeralLabels(
        {
          DEN_GATE_SLOT: "cpu-0a1b2c3d4e",
          DEN_GATE_STORE: "0123456789ab",
          DEN_GATE_CHECKOUT: "ba9876543210",
          DEN_GATE_DIR: dir,
        },
        { keep: true },
      ),
    ).toEqual([
      "--label",
      `${EPHEMERAL_LABEL}=stop`,
      "--label",
      `${RUN_LABEL}=cpu-0a1b2c3d4e`,
      "--label",
      `${STORE_LABEL}=0123456789ab`,
      "--label",
      `${CHECKOUT_LABEL}=ba9876543210`,
    ]);
  });

  it("the checkout is the folder holding .git, found from a folder inside it", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
    expect(checkoutOf(path.join(repo, "packages", "a"))).toBe(repo);
    // A worktree's .git is a file: still its top folder.
    const wt = tmp();
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(checkoutOf(wt)).toBe(wt);
    expect(checkoutTag(repo)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("gate run gives DEN_GATE_CHECKOUT and records it on its slot", async () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    const s = newStore();
    let seenEnv: Record<string, string> | undefined;
    let slotCheckout: string | undefined;
    const d: GateDeps = {
      store: s,
      env: {},
      out: () => {},
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: (_c, _a, env) => {
        seenEnv = env;
        slotCheckout = s.list()[0]?.checkout;
        return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
      },
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: repo,
    };
    await cmdGate(
      ["run", "--kind", "cpu", "--estimate", "1m", "--", "node", "t.js"],
      d,
    );
    expect(seenEnv!.DEN_GATE_CHECKOUT).toBe(checkoutTag(repo));
    expect(slotCheckout).toBe(checkoutTag(repo));
  });
});

describe("issue 1289 (2-4): stopped, never removed", () => {
  it("the sweep stops a kept container once its checkout has no live run; never removes it", async () => {
    const s = newStore();
    const w = world([kept("k1", s, "aaaaaaaaaaaa")]);
    const out = await twice(s, w.docker);
    expect(w.boxes).toHaveLength(1);
    expect(w.boxes[0]!.state).toBe("exited");
    expect(w.calls.some((c) => c[0] === "rm")).toBe(false);
    expect(out).toEqual([expect.objectContaining({ count: 1, stopped: true })]);
  });

  it("kept running while a run from the same checkout holds a slot, even one that didn't make it", async () => {
    const s = newStore();
    // A later run from the same checkout uses the container an earlier
    // (now gone) run made: the container's run label names the gone one.
    s.ask({
      kind: "cpu",
      who: "b",
      label: "later",
      pid: 2,
      checkout: "aaaaaaaaaaaa",
    });
    const w = world([
      kept("k1", s, "aaaaaaaaaaaa", "running", "cpu-00000000ff"),
    ]);
    expect(await twice(s, w.docker)).toEqual([]);
    expect(w.boxes[0]!.state).toBe("running");
  });

  it("an already-stopped container gets no stop", async () => {
    const s = newStore();
    const w = world([kept("k1", s, "aaaaaaaaaaaa", "exited")]);
    expect(await twice(s, w.docker)).toEqual([]);
    expect(w.calls.some((c) => c[0] === "stop")).toBe(false);
  });

  it("another store's, or one with no checkout label, is never stopped", async () => {
    const s = newStore();
    const other = newStore();
    const w = world([kept("k1", other, "aaaaaaaaaaaa"), kept("k2", s, null)]);
    expect(await twice(s, w.docker)).toEqual([]);
    expect(w.boxes.map((b) => b.state)).toEqual(["running", "running"]);
  });

  it("slots it can't read: nothing is stopped", async () => {
    const s = new GateStore({ platform: "linux", dir: tmp() }); // no slots folder
    const w = world([kept("k1", s, "aaaaaaaaaaaa")]);
    expect(await twice(s, w.docker)).toEqual([]);
    expect(w.boxes[0]!.state).toBe("running");
  });

  it("the remove mode never touches a kept container, even of a gone run", async () => {
    const s = newStore();
    const w = world([kept("k1", s, null, "running", "cpu-0000000009")]);
    s.ask({ kind: "cpu", who: "a", label: "a", pid: 1 });
    await twice(s, w.docker);
    await cleanRun(s, "cpu-0000000009", w.docker);
    expect(w.boxes).toHaveLength(1);
  });

  it("gate run's end stops its checkout's kept container when no other run from it is live", async () => {
    const s = newStore();
    const e = s.ask({
      kind: "cpu",
      who: "a",
      label: "a",
      pid: 1,
      checkout: "aaaaaaaaaaaa",
    });
    const w = world([kept("k1", s, "aaaaaaaaaaaa")]);
    s.release(e.id);
    await cleanRun(s, e.id, w.docker, "aaaaaaaaaaaa");
    expect(w.boxes[0]!.state).toBe("exited");
  });

  it("gate run's end leaves it running while another run from the checkout is live", async () => {
    const s = newStore();
    const e = s.ask({
      kind: "cpu",
      who: "a",
      label: "a",
      pid: 1,
      checkout: "aaaaaaaaaaaa",
    });
    s.ask({
      kind: "cpu",
      who: "b",
      label: "b",
      pid: 2,
      checkout: "aaaaaaaaaaaa",
    });
    const w = world([kept("k1", s, "aaaaaaaaaaaa")]);
    s.release(e.id);
    await cleanRun(s, e.id, w.docker, "aaaaaaaaaaaa");
    expect(w.boxes[0]!.state).toBe("running");
  });
});

describe("issue 1289 (5): doctor", () => {
  const row = (
    id: string,
    o: { mode?: "remove" | "stop"; state?: string; checkout?: string | null },
  ) => ({
    id,
    image: "postgres:16",
    run: "cpu-0000000001",
    store: "aaaaaaaaaaaa",
    created: "",
    mode: o.mode ?? "stop",
    state: o.state ?? "exited",
    checkout: o.checkout ?? "cccccccccccc",
  });

  it("counts stopped-and-kept containers apart, never as left over", () => {
    const r = throwawayLines(
      [row("k1", {}), row("k2", {})],
      new Set(),
      "aaaaaaaaaaaa",
      new Set(),
    );
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toMatch(/2 kept \(stopped\)/);
  });

  it("warns about a kept container running with no run from its checkout", () => {
    const r = throwawayLines(
      [
        row("k1", { state: "running" }),
        row("k2", { state: "running", checkout: "dddddddddddd" }),
      ],
      new Set(),
      "aaaaaaaaaaaa",
      new Set(["dddddddddddd"]),
    );
    expect(r.check.status).toBe("warn");
    expect(r.lines.join("\n")).toMatch(/k1.*running.*no run from its checkout/);
    expect(r.lines.join("\n")).not.toMatch(/k2/);
  });
});
