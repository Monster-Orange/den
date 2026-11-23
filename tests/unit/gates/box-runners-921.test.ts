/**
 * Issue 921, box side, slice A: what Den runs on a test box for one CI
 * job. A fresh ephemeral runner container per job, its CPU cap set once,
 * the token only on the container's stdin, and a job hold that clears
 * only its own mark. Pure: nothing here reaches a box. The hook scripts
 * run for real under sh, in a temp folder. Invented repo and box names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BOX_RUNNER_LABEL,
  checkSpec,
  hookScripts,
  runnerArgs,
  runnerScript,
  type BoxRunnerSpec,
} from "../../../src/shared/gates/box-runners.js";

const spec = (o: Partial<BoxRunnerSpec> = {}): BoxRunnerSpec => ({
  project: "south",
  box: "box1",
  repo: "acme/app",
  labels: ["self-hosted", "linux"],
  cpus: 4,
  cpuset: "0-3",
  memoryMb: 8192,
  slot: { id: "cpu-abc123", kind: "cpu" },
  ...o,
});

const opts = {
  image: "ghcr.io/acme/runner:2.320.0",
  marksDir: "/srv/den/holds/box1.jobs",
};

describe("checkSpec", () => {
  it("takes a whole spec", () => {
    expect(checkSpec(spec())).toEqual({ ok: true });
  });

  it.each([
    ["repo", { repo: "app" }],
    ["labels", { labels: [] }],
    ["labels", { labels: ["self hosted"] }],
    ["cpus", { cpus: 0 }],
    ["cpus", { cpus: 65 }],
    ["cpuset", { cpuset: "0-3;rm" }],
    ["memoryMb", { memoryMb: 100 }],
    ["slot", { slot: { id: "", kind: "cpu" as const } }],
  ])("refuses a bad %s", (field, o) => {
    const c = checkSpec(spec(o as Partial<BoxRunnerSpec>));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain(field);
  });
});

describe("runnerArgs: one container per job", () => {
  const argv = runnerArgs(spec(), "r1", opts);

  it("is removed when it exits, and keeps stdin open for the token", () => {
    expect(argv.slice(0, 2)).toEqual(["docker", "run"]);
    expect(argv).toContain("--rm");
    expect(argv).toContain("-i");
    expect(argv).not.toContain("-d");
  });

  it("carries the CPU cap and memory cap it was started with", () => {
    expect(argv).toEqual(
      expect.arrayContaining(["--cpus", "4", "--cpuset-cpus", "0-3"]),
    );
    expect(argv).toEqual(expect.arrayContaining(["--memory", "8192m"]));
  });

  it("leaves out --cpuset-cpus when the spec has none", () => {
    expect(runnerArgs(spec({ cpuset: undefined }), "r1", opts)).not.toContain(
      "--cpuset-cpus",
    );
  });

  it("is labelled as Den's box runner, so nothing else resizes it", () => {
    expect(argv).toEqual(
      expect.arrayContaining(["--label", `${BOX_RUNNER_LABEL}=r1`]),
    );
    expect(argv).toEqual(
      expect.arrayContaining(["--label", "den.box-project=south"]),
    );
  });

  it("mounts the box's job marks folder for the hooks", () => {
    expect(argv).toEqual(
      expect.arrayContaining(["-v", "/srv/den/holds/box1.jobs:/den-hold"]),
    );
  });

  it("never runs docker update", () => {
    expect(argv.join(" ")).not.toMatch(/docker update/);
    expect(runnerScript("r1", spec())).not.toMatch(/docker update/);
  });
});

describe("runnerScript: the token comes from stdin only", () => {
  const script = runnerScript("r1", spec());
  const argv = runnerArgs(spec(), "r1", opts);

  it("reads the token from stdin into the runner's input, then drops it", () => {
    expect(script).toMatch(/IFS= read -r t/);
    expect(script).toMatch(/ACTIONS_RUNNER_INPUT_TOKEN="\$t"/);
    expect(script).toMatch(/unset t/);
  });

  it("never puts --token on a command line", () => {
    expect(script).not.toMatch(/--token/);
    const all = argv.join(" ");
    expect(all).not.toMatch(/--token/);
    // Only ever assigned from what stdin gave ("$t"), never a value.
    expect(all).not.toMatch(/ACTIONS_RUNNER_INPUT_TOKEN=(?!"\$t")/);
    expect(all).not.toMatch(/--env-file|\s-e\s/);
  });

  it("registers one ephemeral runner with the job's labels, then runs it", () => {
    expect(script).toMatch(/config\.sh .*--ephemeral/);
    expect(script).toMatch(/--unattended/);
    expect(script).toMatch(/--url 'https:\/\/github\.com\/acme\/app'/);
    expect(script).toMatch(/--labels 'self-hosted,linux'/);
    expect(script).toMatch(/run\.sh/);
  });

  it("is valid shell, with a quote in a label's way", () => {
    for (const s of [script, runnerScript("r1", spec({ repo: "acme/it's" }))])
      expect(() =>
        execFileSync("sh", ["-n", "-c", s], { stdio: "pipe" }),
      ).not.toThrow();
  });

  it("wires the job-started and job-completed hooks", () => {
    expect(script).toMatch(/ACTIONS_RUNNER_HOOK_JOB_STARTED=/);
    expect(script).toMatch(/ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/);
  });
});

describe("hookScripts: a job's hold clears only its own mark", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  const run = (body: string) =>
    execFileSync("sh", ["-c", body], { stdio: "pipe" });

  it("two jobs' holds don't clear each other's, or the person's", () => {
    const holds = fs.mkdtempSync(path.join(os.tmpdir(), "den-921-"));
    dirs.push(holds);
    fs.writeFileSync(path.join(holds, "person"), "");
    const a = hookScripts("ra", holds);
    const b = hookScripts("rb", holds);
    run(a.started);
    run(b.started);
    expect(fs.readdirSync(holds).sort()).toEqual(["person", "ra", "rb"]);
    run(a.completed);
    expect(fs.readdirSync(holds).sort()).toEqual(["person", "rb"]);
    run(a.completed);
    expect(fs.readdirSync(holds).sort()).toEqual(["person", "rb"]);
    run(b.completed);
    expect(fs.readdirSync(holds)).toEqual(["person"]);
  });

  it("an id can't reach outside the marks folder", () => {
    expect(() => hookScripts("../x", "/den-hold")).toThrow();
    expect(() => hookScripts("a b", "/den-hold")).toThrow();
  });
});
