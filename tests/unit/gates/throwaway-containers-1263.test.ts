/**
 * Issue 1263: containers a gate run starts are removed when its slot ends,
 * and leftovers never outlive their run.
 *
 *  1. `gate run` names the run (DEN_GATE_SLOT); a test helper labels what
 *     it starts with ephemeralLabels(): den.ephemeral=1, den.gate.run and
 *     den.gate.store (which slot store the run is in).
 *  2. When `gate run`'s slot ends, its run's containers are removed, and the
 *     slot log records the count and the image names (never args or env).
 *  3. The server's gate tick sweeps throwaway containers whose run has no
 *     live slot: a slot taken back, lapsed or ended by a person. An
 *     unlabelled container is never touched; a live run's is kept.
 *  4. After a restart, the sweep before services come back removes them;
 *     nothing is ever started.
 *  5. `gate status` (text and --json) and `den doctor` show them.
 *
 * Docker is a fake that applies its label filters, so a container the
 * filter would not list is never seen.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EPHEMERAL_LABEL,
  RUN_LABEL,
  STORE_LABEL,
  storeTag,
  cleanRun,
  ephemeralLabels,
  listThrowaway,
  sweepThrowaway,
  type Docker,
} from "../../../src/shared/gates/ephemeral.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { GateNotices } from "../../../src/ui/server/gate-notices.js";
import { throwawayLines } from "../../../src/ui/cli/doctor-throwaway.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-1263-"));
  tmps.push(d);
  return d;
};

interface Box {
  id: string;
  image: string;
  labels: Record<string, string>;
  created?: string;
}

/** A fake docker over `boxes`: ps applies its label filters; rm -f removes. */
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
              b.created ?? "",
              b.labels[STORE_LABEL] ?? "",
            ].join("\t"),
          )
          .join("\n"),
      };
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

/** A throwaway container; with a run, labelled with `store`'s tag too. */
const throwaway = (
  id: string,
  run: string | null,
  store?: GateStore,
  image = "postgres:16",
) => ({
  id,
  image,
  labels: {
    [EPHEMERAL_LABEL]: "1",
    ...(run ? { [RUN_LABEL]: run } : {}),
    ...(run && store ? { [STORE_LABEL]: storeTag(store.dir) } : {}),
  },
});

const newStore = (alive: (pid: number) => boolean = () => true) =>
  new GateStore({ platform: "linux", dir: tmp(), alive });

describe("issue 1263 (1): a helper labels what it starts", () => {
  it("labels a container with the run, its store, and as throwaway inside a gate run", () => {
    const dir = tmp();
    expect(
      ephemeralLabels({ DEN_GATE_SLOT: "cpu-0a1b2c3d4e", DEN_GATE_DIR: dir }),
    ).toEqual([
      "--label",
      `${EPHEMERAL_LABEL}=1`,
      "--label",
      `${RUN_LABEL}=cpu-0a1b2c3d4e`,
      "--label",
      `${STORE_LABEL}=${storeTag(dir)}`,
    ]);
    // A tag, never the folder's path.
    expect(storeTag(dir)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("uses the store tag gate run gave (DEN_GATE_STORE)", () => {
    expect(
      ephemeralLabels({
        DEN_GATE_SLOT: "cpu-0a1b2c3d4e",
        DEN_GATE_STORE: "0123456789ab",
      }).at(-1),
    ).toBe(`${STORE_LABEL}=0123456789ab`);
  });

  it("outside a gate run it is still throwaway, with no run", () => {
    expect(ephemeralLabels({})).toEqual(["--label", `${EPHEMERAL_LABEL}=1`]);
  });

  it("never puts a strange slot value into a label", () => {
    expect(ephemeralLabels({ DEN_GATE_SLOT: "x;rm -rf /" })).toEqual([
      "--label",
      `${EPHEMERAL_LABEL}=1`,
    ]);
  });
});

describe("issue 1263 (2): a run's containers go when its slot ends", () => {
  it("cleanRun removes the run's containers, keeps the rest, and logs it", async () => {
    const s = newStore();
    const e = s.ask({ kind: "cpu", who: "lane", label: "db test", pid: 1 });
    const w = world([
      throwaway("c1", e.id, s),
      throwaway("c2", e.id, s, "redis:7"),
      throwaway("c3", "cpu-ffffffffff", s),
      { id: "c4", image: "nginx", labels: {} },
    ]);
    s.release(e.id);
    const r = await cleanRun(s, e.id, w.docker);
    expect(r).toEqual({ count: 2, images: ["postgres:16", "redis:7"] });
    expect(w.boxes.map((b) => b.id)).toEqual(["c3", "c4"]);
    const row = s.events().find((x) => x.event === "containers-removed");
    expect(row).toMatchObject({
      id: e.id,
      label: "db test",
      count: 2,
      images: ["postgres:16", "redis:7"],
    });
    // Image names only: no command line, no environment.
    expect(Object.keys(row!).sort()).toEqual(
      ["at", "count", "event", "id", "images", "kind", "label", "who"].sort(),
    );
  });

  it("a run with no containers logs nothing", async () => {
    const s = newStore();
    const e = s.ask({ kind: "cpu", who: "lane", label: "t", pid: 1 });
    s.release(e.id);
    expect(await cleanRun(s, e.id, world([]).docker)).toEqual({
      count: 0,
      images: [],
    });
    expect(s.events().some((x) => x.event === "containers-removed")).toBe(
      false,
    );
  });

  it("gate run removes its run's containers after the command ends", async () => {
    const s = newStore();
    const w = world([]);
    const d: GateDeps = {
      store: s,
      env: {},
      out: () => {},
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      // The command starts a labelled container and exits 0.
      exec: (_c, _a, env) => {
        // gate run gives the command its run and its store's tag.
        expect(env!.DEN_GATE_STORE).toBe(storeTag(s.dir));
        w.boxes.push(throwaway("c9", env!.DEN_GATE_SLOT!, s));
        return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
      },
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/repo",
      docker: w.docker,
    };
    await cmdGate(
      ["run", "--kind", "cpu", "--estimate", "1m", "--", "node", "t.js"],
      d,
    );
    expect(w.boxes).toEqual([]);
    expect(s.list()).toEqual([]);
    expect(s.events().map((x) => x.event)).toContain("containers-removed");
  });

  it("docker missing or failing never breaks the run's end", async () => {
    const s = newStore();
    const e = s.ask({ kind: "cpu", who: "lane", label: "t", pid: 1 });
    s.release(e.id);
    const gone: Docker = async () => {
      throw new Error("spawn docker ENOENT");
    };
    await expect(cleanRun(s, e.id, gone)).resolves.toEqual({
      count: 0,
      images: [],
    });
    expect(await listThrowaway(gone)).toBeNull();
  });
});

describe("issue 1263 (3): the gate tick sweeps leftovers", () => {
  it("removes a run's container once its slot is taken back; keeps a live run's and unlabelled ones", async () => {
    const dead = new Set<number>();
    const s = newStore((pid) => !dead.has(pid));
    const gone = s.ask({ kind: "cpu", who: "a", label: "gone", pid: 11 });
    const live = s.ask({ kind: "cpu", who: "b", label: "live", pid: 12 });
    const w = world([
      throwaway("c1", gone.id, s),
      throwaway("c2", live.id, s),
      { id: "c3", image: "nginx", labels: { [RUN_LABEL]: gone.id } },
      { id: "c4", image: "mine", labels: {} },
    ]);
    dead.add(11); // its run died: the next settle takes the slot back
    const n = new GateNotices({
      store: () => s,
      install: "/x",
      projectOf: () => null,
      relay: async () => true,
      bell: () => {},
      docker: w.docker,
    });
    n.start();
    await n.tick();
    expect(w.boxes.map((b) => b.id)).toEqual(["c2", "c3", "c4"]);
    expect(
      s
        .events()
        .filter((x) => x.event === "containers-removed")
        .map((x) => x.id),
    ).toEqual([gone.id]);
    // rm is only ever given what the throwaway filter listed.
    const rms = w.calls.filter((c) => c[0] === "rm").flat();
    expect(rms).not.toContain("c3");
    expect(rms).not.toContain("c4");
  });

  it("a throwaway container with no run label is left alone by the sweep", async () => {
    const s = newStore();
    const w = world([throwaway("c1", null)]);
    expect(await sweepThrowaway(s, w.docker)).toEqual([]);
    expect(w.boxes).toHaveLength(1);
  });

  it("a run from another slot store is never judged gone here", async () => {
    const here = newStore();
    const there = newStore();
    const run = there.ask({ kind: "cpu", who: "x", label: "x", pid: 31 });
    const w = world([throwaway("c1", run.id, there)]);
    expect(await sweepThrowaway(here, w.docker)).toEqual([]);
    expect(w.boxes).toHaveLength(1);
  });

  it("lists before it reads the live slots, so a run that starts meanwhile keeps its container", async () => {
    const s = newStore();
    const w = world([]);
    let started: string | undefined;
    const docker: Docker = async (args) => {
      const r = await w.docker(args);
      if (args[0] === "ps" && !started) {
        // A run starts and makes its container just after the listing.
        started = s.ask({ kind: "cpu", who: "c", label: "new", pid: 13 }).id;
        w.boxes.push(throwaway("c5", started, s));
      }
      return r;
    };
    await sweepThrowaway(s, docker);
    await sweepThrowaway(s, docker);
    expect(w.boxes.map((b) => b.id)).toEqual(["c5"]);
  });
});

describe("issue 1263 (4): after a restart they never come back", () => {
  it("every slot gone after the restart: the sweep removes them and starts none", async () => {
    const s = newStore(() => true);
    const a = s.ask({ kind: "cpu", who: "a", label: "a", pid: 21 });
    const b = s.ask({ kind: "cpu", who: "b", label: "b", pid: 22 });
    const w = world([throwaway("c1", a.id, s), throwaway("c2", b.id, s)]);
    // The machine restarted: those pids are gone.
    const after = new GateStore({
      platform: "linux",
      dir: s.dir,
      alive: () => false,
    });
    const out = await sweepThrowaway(after, w.docker);
    expect(out.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(w.boxes).toEqual([]);
    expect(w.calls.some((c) => c[0] === "start" || c[0] === "run")).toBe(false);
  });
});

describe("issue 1263 (5): gate status and doctor show them", () => {
  it("gate status --json lists the containers removed for each run", async () => {
    const s = newStore();
    const e = s.ask({ kind: "cpu", who: "lane", label: "db", pid: 1 });
    const w = world([throwaway("c1", e.id, s)]);
    s.release(e.id);
    await cleanRun(s, e.id, w.docker);
    expect(gateView(s).removed).toEqual([
      expect.objectContaining({
        id: e.id,
        label: "db",
        count: 1,
        images: ["postgres:16"],
      }),
    ]);
  });

  it("gate status text says what was removed", async () => {
    const s = newStore();
    const e = s.ask({ kind: "cpu", who: "lane", label: "db", pid: 1 });
    s.release(e.id);
    await cleanRun(s, e.id, world([throwaway("c1", e.id, s)]).docker);
    const out: string[] = [];
    await cmdGate(["status"], {
      store: s,
      env: {},
      out: (l) => out.push(l),
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x",
    });
    expect(out.join("\n")).toMatch(
      new RegExp(`removed 1 container.*db.*${e.id}.*postgres:16`),
    );
  });

  it("doctor warns about leftovers whose run is gone, and lists unlabelled-run ones", () => {
    const r = throwawayLines(
      [
        {
          id: "c1",
          image: "postgres:16",
          run: "cpu-0000000001",
          store: "aaaaaaaaaaaa",
          created: "",
        },
        {
          id: "c2",
          image: "postgres:16",
          run: "cpu-0000000002",
          store: "aaaaaaaaaaaa",
          created: "",
        },
        {
          id: "c3",
          image: "redis:7",
          run: null,
          store: null,
          created: "2026-11-22",
        },
      ],
      new Set(["cpu-0000000002"]),
    );
    expect(r.check).toMatchObject({
      id: "gate_throwaway_containers",
      status: "warn",
    });
    expect(r.check.detail).toMatch(/1 left over/);
    expect(r.lines.join("\n")).toMatch(/c1.*postgres:16.*cpu-0000000001/);
    expect(r.lines.join("\n")).toMatch(/c3.*redis:7.*no gate run/);
    expect(r.lines.join("\n")).not.toMatch(/c2/);
  });

  it("doctor is ok with none, and says when docker can't be asked", () => {
    expect(throwawayLines([], new Set()).check.status).toBe("ok");
    expect(throwawayLines(null, new Set()).check).toMatchObject({
      status: "ok",
      detail: expect.stringMatching(/docker/),
    });
  });
});
