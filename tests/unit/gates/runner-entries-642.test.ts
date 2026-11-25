/**
 * Issue 642, slice 1: CI runner entries on test boxes, and the pure plan
 * of which queued job may start on which box. Nothing here starts a
 * runner, reaches a box or calls the forge. Temp gate dirs only.
 * Invented repo and box names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkRunnerEntry,
  planRunners,
  runnerEntriesOf,
  type PlanBox,
  type QueuedJob,
  type RunnerEntry,
  type RunningJob,
} from "../../../src/shared/gates/runner-entries.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-runner-"));
  tmps.push(d);
  return d;
};

const entry = (repo: string, more: Partial<RunnerEntry> = {}): RunnerEntry => ({
  repo,
  labels: ["self-hosted", "linux", "box-a"],
  routing_variable: "CI_RUNNER",
  box: "box-a",
  slots: 1,
  heavy: true,
  owner: "the owner",
  ...more,
});
const job = (id: string, repo: string, labels = ["self-hosted", "box-a"]) =>
  ({ id, repo, labels }) as QueuedJob;
const box = (name: string, slots: number, used = 0, open = true): PlanBox => ({
  name,
  slots,
  used,
  open,
});

describe("clause 1: two repos on a box with one heavy slot never run at once", () => {
  const entries = [entry("acme/alpha"), entry("acme/beta")];

  it("with both queued, only one starts", () => {
    const p = planRunners(
      [job("j1", "acme/alpha"), job("j2", "acme/beta")],
      [box("box-a", 1)],
      [],
      entries,
    );
    expect(p.start.map((s) => s.job)).toEqual(["j1"]);
    expect(p.wait).toEqual([{ job: "j2", why: "full" }]);
  });

  it("while one runs, the other repo's job waits", () => {
    const p = planRunners(
      [job("j2", "acme/beta")],
      [box("box-a", 1, 1)],
      [{ repo: "acme/alpha", box: "box-a", heavy: true }],
      entries,
    );
    expect(p.start).toEqual([]);
    expect(p.wait).toEqual([{ job: "j2", why: "full" }]);
  });

  it("over many rounds of plan, start and finish, at most one runs at a time", () => {
    const queue: QueuedJob[] = [];
    for (let i = 0; i < 12; i++)
      queue.push(job(`j${i}`, i % 2 ? "acme/beta" : "acme/alpha"));
    const running: (RunningJob & { left: number; job: string })[] = [];
    let most = 0;
    let done = 0;
    for (let tick = 0; tick < 100 && done < 12; tick++) {
      const p = planRunners(
        queue,
        [box("box-a", 1, running.filter((r) => r.heavy).length)],
        running,
        entries,
      );
      for (const s of p.start) {
        queue.splice(
          queue.findIndex((q) => q.id === s.job),
          1,
        );
        running.push({ ...s, left: 1 + (tick % 3) });
      }
      most = Math.max(most, running.length);
      for (const r of running) r.left--;
      for (let i = running.length - 1; i >= 0; i--)
        if (running[i]!.left <= 0) {
          running.splice(i, 1);
          done++;
        }
    }
    expect(done).toBe(12);
    expect(most).toBe(1);
  });
});

describe("the plan", () => {
  it("a box with two slots runs one job from each repo", () => {
    const p = planRunners(
      [
        job("j1", "acme/alpha"),
        job("j2", "acme/alpha"),
        job("j3", "acme/beta"),
      ],
      [box("box-a", 2)],
      [],
      [entry("acme/alpha"), entry("acme/beta")],
    );
    // alpha's entry allows one at a time; beta takes the second slot.
    expect(p.start.map((s) => s.job)).toEqual(["j1", "j3"]);
    expect(p.wait).toEqual([{ job: "j2", why: "full" }]);
  });

  it("a job whose repo or labels match no entry waits with no_entry", () => {
    const p = planRunners(
      [job("j1", "acme/gamma"), job("j2", "acme/alpha", ["gpu"])],
      [box("box-a", 4)],
      [],
      [entry("acme/alpha")],
    );
    expect(p.start).toEqual([]);
    expect(p.wait).toEqual([
      { job: "j1", why: "no_entry" },
      { job: "j2", why: "no_entry" },
    ]);
  });

  it("a held or missing box: box_closed (the controller will route to hosted)", () => {
    const p = planRunners(
      [job("j1", "acme/alpha"), job("j2", "acme/beta")],
      [box("box-a", 1, 0, false)],
      [],
      [entry("acme/alpha"), entry("acme/beta", { box: "box-gone" })],
    );
    expect(p.start).toEqual([]);
    expect(p.wait).toEqual([
      { job: "j1", why: "box_closed" },
      { job: "j2", why: "box_closed" },
    ]);
  });

  it("a light entry takes no gate slot, only its own count", () => {
    const p = planRunners(
      [job("j1", "acme/docs"), job("j2", "acme/docs")],
      [box("box-a", 1, 1)],
      [],
      [entry("acme/docs", { heavy: false, slots: 2 })],
    );
    expect(p.start.map((s) => s.job)).toEqual(["j1", "j2"]);
    expect(p.start.every((s) => !s.heavy)).toBe(true);
  });

  it("a repo on two boxes takes the next box when the first is full", () => {
    const p = planRunners(
      [
        job("j1", "acme/alpha", ["self-hosted"]),
        job("j2", "acme/alpha", ["self-hosted"]),
      ],
      [box("box-a", 1), box("box-b", 1)],
      [],
      [
        entry("acme/alpha"),
        entry("acme/alpha", { box: "box-b", labels: ["self-hosted"] }),
      ],
    );
    expect(p.start.map((s) => [s.job, s.box])).toEqual([
      ["j1", "box-a"],
      ["j2", "box-b"],
    ]);
  });
});

describe("an entry, checked", () => {
  it("takes a good one, with defaults", () => {
    const c = checkRunnerEntry({
      repo: "acme/alpha",
      labels: "self-hosted, linux",
      routing_variable: "CI_RUNNER",
      box: "box-a",
      owner: "the owner",
    });
    expect(c).toEqual({
      ok: true,
      entry: {
        repo: "acme/alpha",
        labels: ["self-hosted", "linux"],
        routing_variable: "CI_RUNNER",
        box: "box-a",
        slots: 1,
        heavy: true,
        owner: "the owner",
      },
    });
  });

  it.each([
    [{ repo: "alpha" }, /owner\/name/],
    // "." and "..": a later slice puts the repo in a URL (review).
    [{ repo: "acme/.." }, /owner\/name/],
    [{ repo: "acme/." }, /owner\/name/],
    [{ box: "-x" }, /box/],
    [{ labels: [] }, /runner labels/],
    [{ labels: ["a b"] }, /label/],
    [{ routing_variable: "GITHUB_X" }, /routing_variable/],
    [{ routing_variable: "1X" }, /routing_variable/],
    [{ slots: 0 }, /slots/],
    [{ heavy: "yes" }, /heavy/],
    [{ owner: "" }, /owner/],
  ])("refuses %j", (bad, why) => {
    const c = checkRunnerEntry({ ...entry("acme/alpha"), ...bad });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toMatch(why);
  });

  it("the file's list drops a bad or repeated one", () => {
    expect(
      runnerEntriesOf([
        entry("acme/alpha"),
        { repo: "nope" },
        entry("ACME/alpha"),
        entry("acme/alpha", { box: "box-b" }),
      ]).map((e) => `${e.repo}@${e.box}`),
    ).toEqual(["acme/alpha@box-a", "acme/alpha@box-b"]);
  });
});

describe("the store keeps them in the gate settings", () => {
  const withBox = () => {
    const s = new GateStore({ dir: tmp() });
    s.setBox({ name: "box-a", ssh: "ci@box-a.example", browser_slots: 1 });
    return s;
  };

  it("none by default; set adds, a second set of the same repo and box replaces", () => {
    const s = withBox();
    expect(s.runnerEntries()).toEqual([]);
    s.setRunnerEntry(entry("acme/alpha"));
    s.setRunnerEntry(entry("acme/alpha", { slots: 2 }));
    expect(s.runnerEntries()).toEqual([entry("acme/alpha", { slots: 2 })]);
    // Other settings stay.
    expect(s.boxes().map((b) => b.name)).toEqual(["box-a"]);
  });

  it("refuses an entry for a box that is not set", () => {
    const s = withBox();
    expect(() =>
      s.setRunnerEntry(entry("acme/alpha", { box: "box-z" })),
    ).toThrow(/no test box box-z/);
  });

  it("removes one by repo and box", () => {
    const s = withBox();
    s.setRunnerEntry(entry("acme/alpha"));
    expect(s.removeRunnerEntry("acme/beta", "box-a")).toBe(false);
    expect(s.removeRunnerEntry("acme/alpha", "box-a")).toBe(true);
    expect(s.runnerEntries()).toEqual([]);
  });
});

function cli(dir: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const store = new GateStore({ dir });
  const d = {
    store,
    env,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  } as unknown as GateDeps;
  return { d, out, err, store };
}

describe("gate runner (CLI)", () => {
  it("add, list, remove as a person", async () => {
    const dir = tmp();
    const c = cli(dir);
    c.store.setBox({ name: "box-a", ssh: "ci@box-a.example" });
    expect(await cmdGate(["runner", "list"], c.d)).toBe(0);
    expect(c.out.pop()).toMatch(/No runner entries/);
    expect(
      await cmdGate(
        [
          "runner",
          "add",
          "acme/alpha",
          "--box",
          "box-a",
          "--labels",
          "self-hosted,linux",
          "--routing-variable",
          "CI_RUNNER",
          "--owner",
          "the owner",
        ],
        c.d,
      ),
    ).toBe(0);
    expect(c.store.runnerEntries()[0]).toMatchObject({
      repo: "acme/alpha",
      labels: ["self-hosted", "linux"],
      heavy: true,
      slots: 1,
    });
    c.out.length = 0;
    await cmdGate(["runner", "list"], c.d);
    expect(c.out.join("\n")).toMatch(
      /acme\/alpha on box-a .*heavy.*CI_RUNNER.*the owner/,
    );
    expect(
      await cmdGate(["runner", "remove", "acme/alpha", "--box", "box-a"], c.d),
    ).toBe(0);
    expect(c.store.runnerEntries()).toEqual([]);
  });

  it("an agent is refused and pointed at the held write", async () => {
    const c = cli(tmp(), { DEN_AGENT: "1" });
    c.store.setBox({ name: "box-a", ssh: "ci@box-a.example" });
    await expect(
      cmdGate(
        [
          "runner",
          "add",
          "acme/alpha",
          "--box",
          "box-a",
          "--labels",
          "x",
          "--routing-variable",
          "V",
          "--owner",
          "o",
        ],
        c.d,
      ),
    ).resolves.not.toBe(0);
    expect(c.err.join("\n")).toMatch(/gate_runner_entry_set/);
    expect(c.store.runnerEntries()).toEqual([]);
  });
});
