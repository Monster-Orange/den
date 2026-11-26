import { afterAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
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

  it("a green last merge needs no bisect", () => {
    const { r, asked } = JSON.parse(firstRed([false, true, false]));
    expect(r).toBeNull();
    expect(asked).toEqual(["c2"]);
  });

  it("a red first merge is the one", () => {
    expect(JSON.parse(firstRed([true, true])).r).toBe("c0");
  });
});
