/**
 * Issue 921, box side, slice A: what Den runs on a test box for one CI
 * job. A fresh ephemeral runner container per job, its CPU cap set once,
 * the token only on the container's stdin, and a job hold that clears
 * only its own mark. Nothing here reaches a box: the box's line runs for
 * real under sh, in a temp folder, with a stand-in docker. Invented repo
 * and box names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BOX_RUNNER_LABEL,
  checkSpec,
  remoteLine,
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
    ["repo", { repo: "acme/.." }],
    ["repo", { repo: "acme/." }],
    ["repo", { repo: "../app" }],
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

  it("mounts nothing from the box: a job can't touch the marks (review)", () => {
    expect(argv).not.toContain("-v");
    expect(argv).not.toContain("--mount");
    expect(argv.join(" ")).not.toContain(opts.marksDir);
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

  it("sets no job hooks: Den keeps the mark, not the job", () => {
    expect(script).not.toMatch(/ACTIONS_RUNNER_HOOK_/);
  });
});

describe("remoteLine: Den keeps the runner's mark on the box, not the job", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * Runs the box's line under sh in a temp home, with a stand-in docker
   * that records the marks folder while "the container" runs, then exits
   * with `code`.
   */
  const onBox = (id: string, code: number, pre: string[] = []) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "den-921-"));
    dirs.push(home);
    const marks = path.join(home, "box1.jobs");
    fs.mkdirSync(marks);
    for (const m of pre) fs.writeFileSync(path.join(marks, m), "");
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\nls -1 '${marks}' > '${home}/during'\nexit ${code}\n`,
      { mode: 0o755 },
    );
    const line = remoteLine(spec(), id, {
      image: opts.image,
      marksDir: "box1.jobs",
    });
    let exit = 0;
    try {
      execFileSync("sh", ["-c", line], {
        cwd: home,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: "pipe",
      });
    } catch (e) {
      exit = (e as { status: number }).status;
    }
    const during = fs.readFileSync(path.join(home, "during"), "utf-8");
    return {
      during: during.split("\n").filter(Boolean),
      after: fs.readdirSync(marks).sort(),
      exit,
    };
  };

  it("the mark is there while the container runs, and gone after", () => {
    const r = onBox("ra", 0, ["person"]);
    expect(r.during.sort()).toEqual(["person", "ra"]);
    expect(r.after).toEqual(["person"]);
    expect(r.exit).toBe(0);
  });

  it("a failed run still clears its mark, and keeps its exit code", () => {
    const r = onBox("ra", 3);
    expect(r.after).toEqual([]);
    expect(r.exit).toBe(3);
  });

  it("two runners' marks don't clear each other's, or the person's", () => {
    const r = onBox("rb", 0, ["person", "ra"]);
    expect(r.during.sort()).toEqual(["person", "ra", "rb"]);
    expect(r.after).toEqual(["person", "ra"]);
  });

  it("an id can't reach outside the marks folder", () => {
    for (const id of ["../x", "a b"])
      expect(() =>
        remoteLine(spec(), id, { image: opts.image, marksDir: "box1.jobs" }),
      ).toThrow();
  });
});
