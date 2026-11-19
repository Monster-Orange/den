/**
 * Issue 498: a reserved `release` gate slot, so a release candidate's bed
 * runs on a quiet machine without queuing behind ordinary runs. The rules
 * are pure; the store lives in a temp DEN_GATE_DIR; the tag proof reads a
 * temp git repo. No Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  grants,
  type GateEntry,
  type GateKind,
} from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { proveReleaseTag } from "../../../src/shared/gates/release-proof.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gaterel-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-15T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: GateKind,
  askedMin: number,
  grantedMin?: number,
  estimateMin = 30,
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin,
  ...(kind === "release" ? { tag: "v1.2.3-dev.1", commit: "c0ffee" } : {}),
  ...(grantedMin !== undefined ? { grantedAt: iso(grantedMin) } : {}),
});

describe("issue 498: the release slot's rules", () => {
  it("has permissive defaults: one release slot, a 10-minute quiet wait", () => {
    expect(GATE_DEFAULTS.releaseSlots).toBe(1);
    expect(GATE_DEFAULTS.releaseQuietWaitMinutes).toBe(10);
  });

  it("clause 5: an ordinary browser line never delays a release run by more than the quiet wait", () => {
    // One ordinary browser run holds the machine for hours; three more wait.
    const q = [
      entry("b1", "browser", 0, 0, 240),
      entry("b2", "browser", 1),
      entry("b3", "browser", 2),
      entry("c1", "cpu", 3),
      entry("r", "release", 5),
    ];
    // Within the wait, the release run waits for the holder to finish.
    expect(grants(q, GATE_DEFAULTS, at(14))).toEqual([]);
    // Past it, the release run starts anyway, ahead of every ordinary waiter.
    expect(grants(q, GATE_DEFAULTS, at(15) + 1)).toEqual(["r"]);
  });

  it("clause 1: a release run never waits behind ordinary waiters; on a free machine it starts at once", () => {
    const q = [
      entry("b2", "browser", 1),
      entry("c1", "cpu", 2),
      entry("r", "release", 9),
    ];
    expect(grants(q, GATE_DEFAULTS, at(9))).toEqual(["r"]);
  });

  it("clause 2: while a release slot is held or waits, new ordinary grants pause", () => {
    const held = [entry("r", "release", 0, 0), entry("b", "browser", 1)];
    expect(grants(held, GATE_DEFAULTS, at(2))).toEqual([]);
    const cpu = [entry("r", "release", 0, 0), entry("c", "cpu", 1)];
    expect(grants(cpu, GATE_DEFAULTS, at(2))).toEqual([]);
    // Waiting for the quiet: the ordinary holder finishes, nothing new starts.
    const waiting = [
      entry("b1", "browser", 0, 0),
      entry("r", "release", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(waiting, GATE_DEFAULTS, at(3))).toEqual([]);
  });

  it("clause 1: ordinary runs never take the release slot; release runs take only theirs", () => {
    const q = [entry("r1", "release", 0, 0), entry("r2", "release", 1)];
    expect(grants(q, GATE_DEFAULTS, at(30))).toEqual([]);
    expect(
      grants(q, { ...GATE_DEFAULTS, releaseSlots: 2 }, at(1)).sort(),
    ).toEqual(["r2"]);
    // Among release waiters, the order is by ask time.
    const two = [
      entry("r2", "release", 3),
      entry("r1", "release", 1),
      entry("b", "browser", 0),
    ];
    expect(grants(two, GATE_DEFAULTS, at(4))).toEqual(["r1"]);
  });

  it("never stops a holder: past the quiet wait the ordinary holder keeps its slot", () => {
    const q = [entry("b1", "browser", 0, 0, 240), entry("r", "release", 1)];
    const g = grants(q, GATE_DEFAULTS, at(60));
    expect(g).toEqual(["r"]);
    expect(q[0]!.grantedAt).toBe(iso(0));
  });
});

describe("issue 498: the release slot's settings", () => {
  it("are settings with permissive limits", () => {
    expect(checkGatePatch({ release_slots: 2 })).toEqual({
      ok: true,
      patch: { release_slots: 2 },
    });
    expect(checkGatePatch({ release_quiet_wait_minutes: 0 })).toEqual({
      ok: true,
      patch: { release_quiet_wait_minutes: 0 },
    });
    expect(checkGatePatch({ release_tag_max_age_hours: 72 }).ok).toBe(true);
    expect(checkGatePatch({ release_slots: 0 }).ok).toBe(false);
    const s = new GateStore({ dir: tmp() });
    s.writeSettings({ release_slots: 3, release_quiet_wait_minutes: 4 });
    expect(s.settings()).toMatchObject({
      releaseSlots: 3,
      releaseQuietWaitMinutes: 4,
    });
  });
});

describe("issue 498: the store", () => {
  it("a release ask needs its proven tag; a duplicate tag is refused", () => {
    const s = new GateStore({ dir: tmp(), alive: () => true });
    expect(() =>
      s.ask({ kind: "release", who: "w", label: "l", pid: 1, estimateMin: 5 }),
    ).toThrow(/tag/);
    s.ask({
      kind: "release",
      who: "w",
      label: "bed",
      pid: 1,
      estimateMin: 5,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    expect(() =>
      s.ask({
        kind: "release",
        who: "w2",
        label: "bed",
        pid: 2,
        estimateMin: 5,
        tag: "v1.2.3-dev.1",
        commit: "abc",
      }),
    ).toThrow(/already/);
  });

  it("clause 2 and 4: a release run that ran anyway records the load and the browser runs beside it, at start and end", () => {
    let now = T0;
    const s = new GateStore({
      dir: tmp(),
      alive: () => true,
      now: () => now,
      load: () => [3.5, 2, 1],
    });
    const b = s.ask({
      kind: "browser",
      who: "lane",
      label: "e2e",
      pid: 1,
      estimateMin: 240,
    });
    const r = s.ask({
      kind: "release",
      who: "bed",
      label: "tag run",
      pid: 2,
      estimateMin: 30,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    expect(r.grantedAt).toBeUndefined();
    now = at(11);
    expect(s.get(r.id)?.grantedAt).toBeDefined();
    expect(s.get(b.id)?.grantedAt).toBeDefined(); // never stopped
    const granted = s
      .events()
      .find((e) => e.event === "granted" && e.id === r.id);
    expect(granted).toMatchObject({
      tag: "v1.2.3-dev.1",
      ranAnyway: true,
      load: [3.5, 2, 1],
      alongside: [{ id: b.id, kind: "browser", label: "e2e" }],
    });
    now = at(30);
    s.release(r.id);
    const released = s
      .events()
      .find((e) => e.event === "released" && e.id === r.id);
    expect(released).toMatchObject({
      load: [3.5, 2, 1],
      alongside: [{ id: b.id, kind: "browser", label: "e2e" }],
    });
  });

  it("clause 3: the view shows the release slot and who holds it", () => {
    const s = new GateStore({ dir: tmp(), alive: () => true });
    const r = s.ask({
      kind: "release",
      who: "Den · bed · a person",
      label: "tag run",
      pid: 1,
      estimateMin: 30,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    const v = gateView(s);
    expect(v.release).toEqual({
      slots: 1,
      held: [{ id: r.id, who: "Den · bed · a person", tag: "v1.2.3-dev.1" }],
    });
    expect(v.slots[0]).toMatchObject({ kind: "release", tag: "v1.2.3-dev.1" });
  });
});

/** A temp repo with a version-setting commit and an annotated tag. */
function repo(version: string, tag: string, tagDate?: string): string {
  const d = tmp();
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        ...a,
      ],
      {
        cwd: d,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...(tagDate ? { GIT_COMMITTER_DATE: tagDate } : {}),
        },
        stdio: "pipe",
      },
    );
  git("init", "-q");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ version }));
  git("add", "package.json");
  git("commit", "-q", "-m", version);
  git("tag", "-a", tag, "-m", "items: 1");
  git("tag", "light-" + tag);
  return d;
}

describe("issue 498: only a release candidate may take the release slot", () => {
  const now = () => Date.now();
  it("an annotated candidate tag on its own version commit is proof", () => {
    const d = repo("1.2.3-dev.1", "v1.2.3-dev.1");
    const p = proveReleaseTag("v1.2.3-dev.1", d, 168, now());
    expect(p).toMatchObject({ ok: true, tag: "v1.2.3-dev.1" });
    expect((p as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    const rel = repo("1.2.3", "v1.2.3");
    expect(proveReleaseTag("v1.2.3", rel, 168, now()).ok).toBe(true);
  });

  it("anything else is refused, saying why", () => {
    const d = repo("1.2.3-dev.1", "v1.2.3-dev.1");
    const no = (tag: string, dir = d, age = 168) => {
      const p = proveReleaseTag(tag, dir, age, now());
      expect(p.ok).toBe(false);
      return (p as { error: string }).error;
    };
    expect(no("lane-run")).toMatch(/not a release/);
    expect(no("v9.9.9")).toMatch(/no tag/);
    expect(no("light-v1.2.3-dev.1")).toMatch(/not a release/);
    // A tag whose commit says another version.
    const other = repo("1.2.2", "v1.2.3-dev.2");
    expect(no("v1.2.3-dev.2", other)).toMatch(/version/);
    // A tag too old to be a candidate.
    const old = repo("1.2.3-dev.3", "v1.2.3-dev.3", "2020-01-01T00:00:00Z");
    expect(no("v1.2.3-dev.3", old)).toMatch(/old/);
    expect(no("v1.2.3-dev.1", tmp())).toMatch(/no tag|not a git/);
  });

  it("an unannotated tag is no proof", () => {
    const d = tmp();
    const git = (...a: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          ...a,
        ],
        {
          cwd: d,
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
          stdio: "pipe",
        },
      );
    git("init", "-q");
    fs.writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ version: "1.2.4" }),
    );
    git("add", "package.json");
    git("commit", "-q", "-m", "x");
    git("tag", "v1.2.4");
    const p = proveReleaseTag("v1.2.4", d, 168, now());
    expect(p.ok).toBe(false);
    expect((p as { error: string }).error).toMatch(/annotated/);
  });
});

function deps(over: Partial<GateDeps> = {}) {
  const dir = tmp();
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const d: GateDeps = {
    store: new GateStore({ dir, alive: () => true, load: () => [1, 1, 1] }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    ...over,
  };
  return { d, out, err, ran };
}

describe("issue 498: gate run --kind release", () => {
  it("needs --tag, and refuses a tag that isn't a candidate before it asks", async () => {
    const t = deps();
    expect(await cmdGate(["run", "--kind", "release", "--", "bed"], t.d)).toBe(
      2,
    );
    expect(t.err.join("\n")).toMatch(/--tag/);
    const d = repo("1.2.3-dev.1", "v1.2.3-dev.1");
    expect(
      await cmdGate(
        ["run", "--kind", "release", "--tag", "nope", "--repo", d, "--", "bed"],
        t.d,
      ),
    ).toBe(2);
    expect(t.ran).toEqual([]);
    expect(t.d.store.events()).toEqual([]);
    // --tag means nothing to an ordinary run.
    expect(
      await cmdGate(["run", "--kind", "browser", "--tag", "x", "--", "e"], t.d),
    ).toBe(2);
  });

  it("a proven candidate runs in the release slot, and says the load at its start and end", async () => {
    const t = deps();
    const d = repo("1.2.3-dev.1", "v1.2.3-dev.1");
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "release",
          "--tag",
          "v1.2.3-dev.1",
          "--repo",
          d,
          "--",
          "bed",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.ran).toEqual([["bed"]]);
    const asked = t.d.store.events().find((e) => e.event === "asked");
    expect(asked).toMatchObject({ kind: "release", tag: "v1.2.3-dev.1" });
    const said = t.err.join("\n");
    expect(said).toMatch(/release run starts: load 1\.00 1\.00 1\.00/);
    expect(said).toMatch(/release run ended: load 1\.00 1\.00 1\.00/);
  });

  it("clause 3: gate status shows the release slot and who holds it", async () => {
    const t = deps();
    expect(await cmdGate(["status"], t.d)).toBe(0);
    t.d.store.ask({
      kind: "release",
      who: "Den · bed · a person",
      label: "tag run",
      pid: 1,
      estimateMin: 30,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    t.out.length = 0;
    expect(await cmdGate(["status"], t.d)).toBe(0);
    const said = t.out.join("\n");
    expect(said).toMatch(
      /Release slot: held by Den · bed · a person \(v1\.2\.3-dev\.1\)/,
    );
    expect(said).toMatch(/holds release \(v1\.2\.3-dev\.1\)/);
  });

  it("settings: a person sets the release slot's settings", async () => {
    const t = deps();
    expect(
      await cmdGate(
        [
          "settings",
          "--release-slots",
          "2",
          "--release-quiet-wait-minutes",
          "5",
          "--cancel-grace-seconds",
          "20",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.d.store.settings()).toMatchObject({
      releaseSlots: 2,
      releaseQuietWaitMinutes: 5,
      cancelGraceSeconds: 20,
    });
  });
});
