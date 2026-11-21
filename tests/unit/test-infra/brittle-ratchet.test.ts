/**
 * Issue 839: a ratchet on brittle patterns in browser tests and live checks
 * (scripts/brittle-ratchet.mjs). Per file under tests/**\/*.browser.* and
 * gate/*.mjs it counts fixed sleeps, positional picks, raw class selectors
 * and exact English-text asserts.
 *
 * A pull request is judged against its merge base, never a hand-kept file:
 * for each file the change touched, the count at the merge base and at HEAD.
 * A count that goes up fails; one that goes down never does, and a file the
 * change didn't touch is never judged. Two pull requests, each green alone,
 * once turned main red when both moved a hand-kept baseline; with nothing
 * shared between them, that can't happen. --report prints totals and never
 * fails (a push to main, and the weekly numbers).
 *
 * Each case builds a temp git repo. The script is plain Node (another repo
 * may copy it alone), so each run is a child Node.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "brittle-ratchet.mjs");
const KINDS = ["sleeps", "positional", "classSelectors", "englishAsserts"];

/** One of each brittle pattern, each on its own known line. */
const PLANTED = [
  'import { test, expect } from "@playwright/test";', // 1
  'test("planted", async ({ page }) => {', // 2
  "  await page.waitForTimeout(500);", // 3: sleep
  '  await page.getByRole("row").nth(2).click();', // 4: positional
  '  await page.locator(".den-card .title").click();', // 5: class selector
  '  expect(await page.textContent("#x")).toBe("Saved your changes");', // 6: English
  "});", // 7
  "",
].join("\n");

/** The same intent, written the way the check suggests: no counts. */
const CLEAN = [
  'import { test, expect } from "@playwright/test";',
  'test("clean", async ({ page }) => {',
  '  const row = page.getByRole("row", { name: "north" });',
  "  await expect(row).toBeVisible();",
  '  await page.getByLabel("Name").fill("north");',
  '  await page.locator("[data-card=north]").click();',
  '  expect(await row.getAttribute("data-state")).toBe("saved");',
  "  await new Promise((r) => setTimeout(r, 20));",
  "  // await page.waitForTimeout(500); a comment never counts",
  "  /* it used to pick li:nth-child(2) */",
  "  const s = \"page.locator('.x').nth(1)\"; // nor a string's text",
  "});",
  "",
].join("\n");

const sleeps = (n: number) =>
  Array.from({ length: n }, () => "await page.waitForTimeout(500);\n").join("");

// A git that ignores the person's own config (signing, hooks, templates)
// and any GIT_* a hook that runs jest may have set.
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
);
GIT_ENV.GIT_CONFIG_GLOBAL = os.devNull;
GIT_ENV.GIT_CONFIG_NOSYSTEM = "1";
GIT_ENV.GIT_AUTHOR_NAME = GIT_ENV.GIT_COMMITTER_NAME = "test";
GIT_ENV.GIT_AUTHOR_EMAIL = GIT_ENV.GIT_COMMITTER_EMAIL = "test@example.invalid";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/** Writes (or, for null, deletes) files and commits them. */
function commit(dir: string, files: Record<string, string | null>) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (body === null) fs.rmSync(p);
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
}

/** A repo whose main holds `files`, checked out on a new branch "pr". */
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brittle-"));
  git(dir, "init", "-q", "-b", "main");
  commit(dir, { "README.md": "x\n", ...files });
  git(dir, "checkout", "-q", "-b", "pr");
  return dir;
}

function run(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

type Failure = {
  file: string;
  kind: string;
  base: number;
  head: number;
  lines: number[];
};
function judged(dir: string, extra: string[] = []) {
  const r = run(dir, ["--base", "main", "--json", ...extra]);
  return {
    code: r.code,
    ...(JSON.parse(r.stdout) as {
      files: Record<string, Record<string, { base: number; head: number }>>;
      failures: Failure[];
    }),
  };
}

describe("the brittle-pattern ratchet (issue 839)", () => {
  it("a new file with a planted sleep, nth pick, class selector and English assert fails on each", () => {
    const dir = repo({});
    commit(dir, { "tests/unit/planted.browser.test.ts": PLANTED });
    const r = run(dir, ["--base", "main"]);
    expect(r.code).toBe(1);
    const j = judged(dir);
    const byKind = Object.fromEntries(j.failures.map((f) => [f.kind, f.lines]));
    expect(byKind).toEqual({
      sleeps: [3],
      positional: [4],
      classSelectors: [5],
      englishAsserts: [6],
    });
    // The message names the file, the kind, the lines and the counts, and
    // says what to write instead.
    expect(r.out).toContain("tests/unit/planted.browser.test.ts");
    for (const k of KINDS) expect(r.out).toContain(k);
    expect(r.out).toMatch(/line 3\b/);
    expect(r.out).toMatch(/0 -> 1/);
    expect(r.out).toMatch(/new file/);
    expect(r.out).toMatch(/getByRole|getByLabel/);
    expect(r.out).toMatch(/wait for a state|toBeVisible|expect\.poll/);
  });

  it("covers live checks (gate/*.mjs) as well", () => {
    const dir = repo({});
    commit(dir, { "gate/901.mjs": PLANTED });
    const j = judged(dir);
    expect(j.code).toBe(1);
    expect(j.failures).toHaveLength(4);
  });

  it("leaves other files alone (a unit test, a gate helper folder)", () => {
    const dir = repo({});
    commit(dir, {
      "tests/unit/plain.test.ts": PLANTED,
      "gate/lib/helper.mjs": PLANTED,
    });
    expect(run(dir, ["--base", "main"]).code).toBe(0);
  });

  it("counts nothing in a file written with role/label finders and state waits", () => {
    const dir = repo({});
    commit(dir, { "tests/unit/clean.browser.test.ts": CLEAN });
    const j = judged(dir);
    expect(j.code).toBe(0);
    expect(j.failures).toEqual([]);
  });

  it("a change that raises a count in a file it touched fails", () => {
    const file = "tests/unit/x.browser.test.ts";
    const dir = repo({ [file]: sleeps(1) });
    commit(dir, {
      [file]: sleeps(1) + "await new Promise((r) => setTimeout(r, 250));\n",
    });
    const r = run(dir, ["--base", "main"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/sleeps 1 -> 2/);
    const j = judged(dir);
    expect(j.failures.map((f) => [f.file, f.kind, f.base, f.head])).toEqual([
      [file, "sleeps", 1, 2],
    ]);
  });

  it("a change that lowers counts passes, and says so", () => {
    const file = "tests/unit/x.browser.test.ts";
    const dir = repo({ [file]: PLANTED + sleeps(3) });
    commit(dir, { [file]: sleeps(1) });
    const r = run(dir, ["--base", "main"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/went down/);
    // Deleting a file with counts passes too.
    commit(dir, { [file]: null });
    expect(run(dir, ["--base", "main"]).code).toBe(0);
  });

  it("a file the change didn't touch is never judged, however many it has", () => {
    const dir = repo({
      "tests/unit/old.browser.test.ts": PLANTED + sleeps(20),
      "tests/unit/touched.browser.test.ts": sleeps(2),
    });
    // Touch one file without raising its count.
    commit(dir, {
      "tests/unit/touched.browser.test.ts": sleeps(2) + "// more\n",
    });
    const j = judged(dir);
    expect(j.code).toBe(0);
    expect(Object.keys(j.files)).toEqual([
      "tests/unit/touched.browser.test.ts",
    ]);
  });

  it("a renamed file is judged against its old path", () => {
    const dir = repo({ "tests/unit/a.browser.test.ts": PLANTED });
    git(
      dir,
      "mv",
      "tests/unit/a.browser.test.ts",
      "tests/unit/b.browser.test.ts",
    );
    git(dir, "commit", "-q", "-m", "rename");
    expect(run(dir, ["--base", "main"]).code).toBe(0);
  });

  it("the race: two changes from one base, each green alone, stay green merged in turn", () => {
    const x = "tests/unit/x.browser.test.ts";
    const y = "tests/unit/y.browser.test.ts";
    const dir = repo({ [x]: sleeps(2) + "// x\n", [y]: sleeps(1) });
    // PR B: from the same base, touches X and Y, raises nothing.
    git(dir, "checkout", "-q", "-b", "b", "main");
    commit(dir, {
      [y]: sleeps(1) + CLEAN,
      [x]: "// b was here\n" + sleeps(2) + "// x\n",
    });
    expect(run(dir, ["--base", "main"]).code).toBe(0);
    // PR A: lowers X, merges first.
    git(dir, "checkout", "-q", "-b", "a", "main");
    commit(dir, { [x]: sleeps(1) + "// x\n" });
    expect(run(dir, ["--base", "main"]).code).toBe(0);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge a", "a");
    // B, judged again now A is on main (its merge base is still the old
    // base), and B's merge into main (judged against main), both pass.
    git(dir, "checkout", "-q", "b");
    expect(run(dir, ["--base", "main"]).code).toBe(0);
    git(dir, "checkout", "-q", "-b", "b-merged", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge b", "b");
    expect(run(dir, ["--base", "main"]).code).toBe(0);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--ff-only", "b-merged");
    // A push to main reports and never fails.
    const r = run(dir, ["--report"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sleeps\s+2/);
  });

  it("a shallow clone with no merge base fails with a clear message rather than passing", () => {
    const origin = repo({ "tests/unit/x.browser.test.ts": sleeps(1) });
    commit(origin, { "tests/unit/x.browser.test.ts": sleeps(5) });
    git(origin, "checkout", "-q", "main");
    commit(origin, { "README.md": "main moved on\n" });
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "brittle-shallow-"));
    git(
      shallow,
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      "pr",
      `file://${origin}`,
      ".",
    );
    // The base ref isn't here at all.
    let r = run(shallow, ["--base", "origin/main"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/merge base/);
    expect(r.out).toMatch(/fetch-depth: 0/);
    // The base is here, but not the history back to where they meet.
    git(
      shallow,
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      "main:refs/remotes/origin/main",
    );
    r = run(shallow, ["--base", "origin/main"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/merge base/);
    expect(r.out).toMatch(/fetch-depth: 0/);
  });

  it("takes other file globs (a copy in another repo)", () => {
    const dir = repo({});
    commit(dir, {
      "e2e/flows/planted.spec.ts": PLANTED,
      "tests/unit/planted.browser.test.ts": PLANTED,
    });
    const j = judged(dir, ["--files", "e2e/**/*.spec.ts"]);
    expect(j.code).toBe(1);
    expect(Object.keys(j.files)).toEqual(["e2e/flows/planted.spec.ts"]);
    expect(j.failures.map((f) => f.kind).sort()).toEqual([...KINDS].sort());
  });

  it("the hand-kept baseline's options are refused with what replaced them", () => {
    const dir = repo({});
    for (const args of [
      [],
      ["--baseline", "b.json"],
      ["--update"],
      ["--init"],
    ]) {
      const r = run(dir, args);
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.out).toMatch(/--base <ref>/);
      expect(r.out).toMatch(/--report/);
    }
  });

  it("--report prints totals per kind (the weekly numbers) and never fails", () => {
    const dir = repo({
      "tests/unit/a.browser.test.ts": PLANTED,
      "gate/9.mjs": sleeps(2),
    });
    const r = run(dir, ["--report"]);
    expect(r.code).toBe(0);
    for (const k of KINDS) expect(r.out).toContain(k);
    const j = JSON.parse(run(dir, ["--report", "--json"]).stdout);
    expect(j.totals).toEqual({
      sleeps: 3,
      positional: 1,
      classSelectors: 1,
      englishAsserts: 1,
    });
    expect(j.files["gate/9.mjs"]).toEqual({ sleeps: 2 });
  });

  it("imports nothing but Node's own modules (it runs when copied alone)", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const from = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(from.length).toBeGreaterThan(0);
    for (const f of from) expect(f).toMatch(/^node:/);
  });

  it("reports this repo in a few seconds, and no hand-kept baseline is left", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT, "--report"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sleeps/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fs.existsSync(path.join(ROOT, "tests/brittle-baseline.json"))).toBe(
      false,
    );
  });

  it("CI judges a pull request against its base with full history; a push to main only reports", () => {
    const ci = yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          steps: {
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }[];
        }
      >;
    };
    const pr = ci.jobs.pr.steps;
    const runs = pr.map((st) => st.run ?? "");
    const at = runs.findIndex((r) => r.includes("scripts/brittle-ratchet.mjs"));
    expect(at).toBeGreaterThan(runs.indexOf("npm run lint"));
    expect(runs[at]).toMatch(
      /--base\s+"?\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}"?/,
    );
    const checkout = pr.find((st) =>
      (st.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    // On main: --report or nothing, never a step that can fail on a race.
    for (const st of ci.jobs.checks.steps)
      if ((st.run ?? "").includes("brittle-ratchet"))
        expect(st.run).toMatch(/--report/);
  });
});
