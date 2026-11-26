import { afterAll, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "queue-merge-tests.mjs");
const AFFECTED = path.join(ROOT, "scripts", "affected-tests.mjs");

function call<T>(script: string, fn: string, args: unknown[]): T {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(script)});
       const args = JSON.parse(process.argv[1]);
       const r = await m[${JSON.stringify(fn)}](...args);
       const plain = (k, v) => (v instanceof Map ? Object.fromEntries(v) : v);
       console.log(JSON.stringify(r ?? null, plain));`,
      JSON.stringify(args),
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as T;
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-queue-merge-"));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
const git = (...a: string[]) =>
  execFileSync("git", a, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();
const commit = (file: string, text: string, msg: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  git("add", file);
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};

git("init", "-q", "-b", "queue");
const a = commit("src/settings.js", "rows = [1];\n", "a");
const b = commit("src/other.js", "x = 1;\n", "b");
git("checkout", "-q", "-b", "pr-old", a);
const prOld = commit("src/settings.js", "rows = [1, 2];\n", "a row, no pin");
git("checkout", "-q", "-b", "pr-new", b);
const prNew = commit("src/other.js", "x = 2;\n", "other");
git("checkout", "-q", "queue");
commit("tests/unit/pin.test.ts", "pins rows\n", "the pin test");
git(
  "-c",
  "commit.gpgsign=false",
  "merge",
  "-q",
  "--no-ff",
  "--no-edit",
  "pr-old",
);
const merged = git("rev-parse", "HEAD");
const before = git("rev-parse", "HEAD^1");

describe("queue-merge-tests: the merged tree's union", () => {
  it("a batch's base is its oldest fork point from the queue", () => {
    expect(
      call<string>(SCRIPT, "oldestForkPoint", [before, [prNew, prOld], repo]),
    ).toBe(a);
    expect(
      call<string>(SCRIPT, "oldestForkPoint", [before, [prNew], repo]),
    ).toBe(b);
  });

  it("a head already in the queue is refused: the queue must be as it was before the merge", () => {
    expect(() =>
      call(SCRIPT, "oldestForkPoint", [merged, [prOld], repo]),
    ).toThrow(/already in/);
  });

  it("the union holds a test the queue added after the pull request went green", () => {
    const base = call<string>(SCRIPT, "oldestForkPoint", [
      before,
      [prOld],
      repo,
    ]);
    const own = git("diff", "--name-only", `${base}...${prOld}`).split("\n");
    const union = call<string[]>(SCRIPT, "changedFiles", [base, merged, repo]);
    expect(own).not.toContain("tests/unit/pin.test.ts");
    expect(union).toContain("tests/unit/pin.test.ts");
    expect(union).toContain("src/settings.js");
  });

  it("a test in the union is picked as a changed test", () => {
    const s = call<{ files: Record<string, string[]> }>(
      AFFECTED,
      "selectTests",
      [
        {
          changed: ["src/settings.js", "tests/unit/pin.test.ts"],
          allTests: ["tests/unit/pin.test.ts", "tests/unit/else.test.ts"],
          related: [],
          map: { everything: [], smoke: [], rules: [] },
        },
      ],
    );
    expect(Object.keys(s.files)).toEqual(["tests/unit/pin.test.ts"]);
  });
});

describe("queue-merge-tests: the first red merge of a batch", () => {
  const firstRed = (states: boolean[]) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { firstRed } = await import(${JSON.stringify(SCRIPT)});
         const red = JSON.parse(process.argv[1]);
         const asked = [];
         const r = await firstRed(red.map((_, i) => "c" + i), async (c) => (asked.push(c), red[Number(c.slice(1))]));
         console.log(JSON.stringify({ r, asked }));`,
        JSON.stringify(states),
      ],
      { encoding: "utf-8" },
    );

  it("halves to the merge that turned it red", () => {
    const { r, asked } = JSON.parse(
      firstRed([false, false, false, true, true, true, true]),
    );
    expect(r).toBe("c3");
    expect(asked.length).toBeLessThanOrEqual(4);
  });

  it("a last merge that is green again has no first red", () => {
    const { r, asked } = JSON.parse(firstRed([false, true, false]));
    expect(r).toBeNull();
    expect(asked).toEqual(["c2"]);
  });

  it("a red first merge is the one", () => {
    expect(JSON.parse(firstRed([true, true])).r).toBe("c0");
  });
});

describe("queue-merge-tests: what a plan ran, and why", () => {
  it("counts the tests by reason, a test with two reasons in each", () => {
    const out = call<string>(SCRIPT, "tally", [
      [
        "tests/a.test.ts  # related",
        "tests/b.test.ts  # related; mapped: src/x.js (the Settings rows: their pin and the tests that read them)",
        "tests/c.test.ts  # smoke",
      ].join("\n"),
    ]);
    expect(out).toContain("3 tests, by reason:");
    expect(out).toContain("  2  related");
    expect(out).toContain(
      "  1  mapped (the Settings rows: their pin and the tests that read them)",
    );
    expect(out).toContain("  1  smoke");
  });

  it("a plan of every test says so", () => {
    expect(call<string>(SCRIPT, "tally", ["ALL\n"])).toBe(
      "queue-merge-tests: every test (the reason is on the line above)",
    );
  });
});

describe("queue-merge-tests: bisect on a real repo", () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "den-queue-bisect-"));
  afterAll(() => fs.rmSync(r2, { recursive: true, force: true }));
  const g = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: r2,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    }).trim();
  const put = (f: string, text: string) => {
    fs.writeFileSync(path.join(r2, f), text);
    g("add", f);
    g("-c", "commit.gpgsign=false", "commit", "-q", "-m", f);
    return g("rev-parse", "HEAD");
  };
  g("init", "-q", "-b", "queue");
  const first = put("a.txt", "a\n");
  const second = put("x.mjs", "process.exit(1);\n");

  it("a test the batch's later merge adds is not red at an earlier merge", () => {
    const red = call<string | null>(SCRIPT, "bisectRun", [
      { commits: [first, second], tests: ["x.mjs"], run: "node", root: r2 },
    ]);
    expect(red).toBe(second);
    expect(g("worktree", "list").split("\n")).toHaveLength(1);
  });

  const cli = (list: string, commits: string[]) => {
    const f = path.join(
      os.tmpdir(),
      `queue-bisect-list-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(f, list);
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "bisect",
        "--tests",
        f,
        "--run",
        "node",
        "--repo",
        r2,
        ...commits,
      ],
      { encoding: "utf-8" },
    );
    fs.rmSync(f);
    return r;
  };

  it("a known-red batch that is green on the re-run says not reproduced, and fails", () => {
    const r = cli("x.mjs\n", [second, put("x.mjs", "process.exit(0);\n")]);
    expect(r.stdout.trim()).toBe("not reproduced");
    expect(r.status).toBe(3);
    expect(g("worktree", "list").split("\n")).toHaveLength(1);
  });

  const check = (plan: string, commits: string[], run = "node") => {
    const f = path.join(
      os.tmpdir(),
      `queue-check-plan-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(f, plan);
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "check",
        "--plan",
        f,
        "--run",
        run,
        "--repo",
        r2,
        ...commits.flatMap((c) => ["--merged", c]),
      ],
      { encoding: "utf-8" },
    );
    fs.rmSync(f);
    return r;
  };

  it("check: a red merged tree fails (exit 1) and names the merge that turned it red", () => {
    const ok = put("y.mjs", "process.exit(0);\n");
    const bad = put("y.mjs", "process.exit(1);\n");
    const r = check("y.mjs  # names y.mjs\n", [ok, bad]);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe(bad);
    expect(r.stderr).toMatch(/red at/);
    expect(g("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("check: a green merged tree passes (exit 0)", () => {
    const r = check("y.mjs\n", [put("y.mjs", "process.exit(0);\n")]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/green/);
  });

  it("check: an every-test plan is CI only (exit 4), and nothing runs", () => {
    const r = check("ALL\n", [first], "node -e process.exit(9)");
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/every test: CI only/);
  });

  it("check: browser files are left out of the run, and a list left empty runs nothing (exit 0)", () => {
    const r = check(
      "tests/a.browser.test.ts\n",
      [first],
      "node -e process.exit(9)",
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/1 browser test left to CI/);
    expect(r.stderr).toMatch(/no tests to run/);
  });

  it("--run keeps a quoted part after = as part of its word", () => {
    expect(
      call<string[]>(SCRIPT, "splitRun", [`cli --label='a b' -- jest`]),
    ).toEqual(["cli", "--label=a b", "--", "jest"]);
  });

  it("check with no --run is refused, so jest never runs outside the caller's queue", () => {
    const f = path.join(os.tmpdir(), `queue-check-norun-${process.pid}`);
    fs.writeFileSync(f, "y.mjs\n");
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "check", "--plan", f, "--merged", first, "--repo", r2],
      { encoding: "utf-8" },
    );
    fs.rmSync(f);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toMatch(/tests on/);
  });

  it("--run keeps a quoted label as one word (the gate's --label)", () => {
    expect(
      call<string[]>(SCRIPT, "splitRun", [
        `cli gate run --label 'lane1 qmerge merge-tests' --estimate 6m -- npx jest`,
      ]),
    ).toEqual([
      "cli",
      "gate",
      "run",
      "--label",
      "lane1 qmerge merge-tests",
      "--estimate",
      "6m",
      "--",
      "npx",
      "jest",
    ]);
  });

  it("an every-test plan is refused, not read as green", () => {
    const r = cli("ALL  # the queue changed package-lock.json\n", [
      first,
      second,
    ]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/every test/);
    expect(g("worktree", "list").split("\n")).toHaveLength(1);
  });
});
