/**
 * Issue 839: a ratchet on brittle patterns in browser tests and live checks
 * (scripts/brittle-ratchet.mjs). Per file under tests/**\/*.browser.* and
 * gate/*.mjs it counts fixed sleeps, positional picks, raw class selectors
 * and exact English-text asserts; tests/brittle-baseline.json holds the
 * counts the repo has today. A count that goes up, or a new file with any,
 * fails; a count that goes down never does, and the check says how to lower
 * the baseline (--update, which only ever lowers).
 *
 * Each case plants files in a temp dir with its own baseline. The script is
 * plain Node (another repo may copy it alone), so each run is a child Node.
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

function scratch(files: Record<string, string>, baseline?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brittle-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const base = path.join(dir, "baseline.json");
  if (baseline !== undefined)
    fs.writeFileSync(base, JSON.stringify(baseline, null, 2) + "\n");
  return { dir, base };
}

function run(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function counts(dir: string, base: string, extra: string[] = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--root", dir, "--baseline", base, "--json", ...extra],
    { encoding: "utf8" },
  );
  return JSON.parse(r.stdout) as {
    files: Record<string, Record<string, { count: number; lines: number[] }>>;
    failures: { file: string; kind: string; lines: number[] }[];
  };
}

describe("the brittle-pattern ratchet (issue 839)", () => {
  it("clause 3: a planted sleep, nth pick, class selector and English assert each fail it", () => {
    const { dir, base } = scratch(
      { "tests/unit/planted.browser.test.ts": PLANTED },
      { files: {} },
    );
    const r = run(dir, ["--baseline", base]);
    expect(r.code).toBe(1);
    const j = counts(dir, base);
    expect(j.failures.map((f) => f.kind).sort()).toEqual([...KINDS].sort());
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
    expect(r.out).toMatch(/1 > 0/);
    expect(r.out).toMatch(/getByRole|getByLabel/);
    expect(r.out).toMatch(/wait for a state|toBeVisible|expect\.poll/);
  });

  it("covers live checks (gate/*.mjs) as well", () => {
    const { dir, base } = scratch({ "gate/901.mjs": PLANTED }, { files: {} });
    expect(run(dir, ["--baseline", base]).code).toBe(1);
    expect(counts(dir, base).failures).toHaveLength(4);
  });

  it("leaves other files alone (a unit test, a gate helper folder)", () => {
    const { dir, base } = scratch(
      {
        "tests/unit/plain.test.ts": PLANTED,
        "gate/lib/helper.mjs": PLANTED,
      },
      { files: {} },
    );
    expect(run(dir, ["--baseline", base]).code).toBe(0);
  });

  it("counts nothing in a file written with role/label finders and state waits", () => {
    const { dir, base } = scratch(
      { "tests/unit/clean.browser.test.ts": CLEAN },
      { files: {} },
    );
    const r = run(dir, ["--baseline", base]);
    expect(r.code).toBe(0);
    expect(counts(dir, base).files).toEqual({});
  });

  it("passes at the baseline, and fails when one kind goes up by one", () => {
    const file = "tests/unit/planted.browser.test.ts";
    const at = {
      sleeps: 1,
      positional: 1,
      classSelectors: 1,
      englishAsserts: 1,
    };
    const { dir, base } = scratch(
      { [file]: PLANTED },
      { files: { [file]: at } },
    );
    expect(run(dir, ["--baseline", base]).code).toBe(0);

    fs.appendFileSync(
      path.join(dir, file),
      "await new Promise((r) => setTimeout(r, 250));\n",
    );
    const r = run(dir, ["--baseline", base]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/sleeps.*2 > 1/);
    expect(counts(dir, base).failures.map((f) => f.kind)).toEqual(["sleeps"]);
  });

  it("never fails when counts go down, prints the --update command, and --update only lowers", () => {
    const file = "tests/unit/planted.browser.test.ts";
    const gone = "tests/unit/deleted.browser.test.ts";
    const { dir, base } = scratch(
      { [file]: PLANTED },
      {
        files: {
          [file]: {
            sleeps: 3,
            positional: 1,
            classSelectors: 1,
            englishAsserts: 1,
          },
          [gone]: { sleeps: 2 },
        },
      },
    );
    const r = run(dir, ["--baseline", base]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--update");

    expect(run(dir, ["--baseline", base, "--update"]).code).toBe(0);
    const after = JSON.parse(fs.readFileSync(base, "utf8"));
    expect(after.files[file].sleeps).toBe(1);
    expect(after.files[gone]).toBeUndefined();

    // A count above the baseline is never written by --update.
    fs.appendFileSync(path.join(dir, file), "await page.waitForTimeout(1);\n");
    expect(run(dir, ["--baseline", base, "--update"]).code).toBe(1);
    expect(JSON.parse(fs.readFileSync(base, "utf8")).files[file].sleeps).toBe(
      1,
    );
  });

  it("a new file not in the baseline fails with any count, and --update never adds it", () => {
    const { dir, base } = scratch(
      { "tests/unit/new.browser.test.ts": "await page.waitForTimeout(100);\n" },
      { files: {} },
    );
    expect(run(dir, ["--baseline", base]).code).toBe(1);
    expect(run(dir, ["--baseline", base, "--update"]).code).toBe(1);
    expect(JSON.parse(fs.readFileSync(base, "utf8")).files).toEqual({});
  });

  it("takes other file globs and a baseline path (a copy in another repo)", () => {
    const { dir, base } = scratch(
      {
        "e2e/flows/planted.spec.ts": PLANTED,
        "tests/unit/planted.browser.test.ts": PLANTED,
      },
      { files: {} },
    );
    const args = ["--files", "e2e/**/*.spec.ts", "--baseline", base];
    expect(run(dir, args).code).toBe(1);
    const j = counts(dir, base, ["--files", "e2e/**/*.spec.ts"]);
    expect(Object.keys(j.files)).toEqual(["e2e/flows/planted.spec.ts"]);
    expect(j.failures.map((f) => f.kind).sort()).toEqual([...KINDS].sort());
  });

  it("imports nothing but Node's own modules (it runs when copied alone)", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const from = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(from.length).toBeGreaterThan(0);
    for (const f of from) expect(f).toMatch(/^node:/);
  });

  it("this repo is at or under its baseline, in a few seconds", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).not.toMatch(/went up|new file/);
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("clause 4: CI runs it with the other checks, on a push and a pull request", () => {
    const ci = yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, { steps: { run?: string }[] }> };
    for (const job of ["checks", "pr"]) {
      const runs = ci.jobs[job].steps.map((st) => st.run ?? "");
      const at = runs.indexOf("node scripts/brittle-ratchet.mjs");
      expect([job, at >= 0]).toEqual([job, true]);
      // Among the static checks: after lint, next to the den-ui gate.
      expect(at).toBeGreaterThan(runs.indexOf("npm run lint"));
    }
  });
});
