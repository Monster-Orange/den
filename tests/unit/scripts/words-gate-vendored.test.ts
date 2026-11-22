/**
 * Issue 770: the words gate (scripts/words-gate.mjs) leaves out
 * src/shared/agents/detect/rules, which holds other products' screen text
 * (herdr's rule sets, matched against what an agent's CLI prints): those
 * words are theirs, and a rule must match them exactly. Narrowly: only
 * that folder, and every file in it must start with the header that says
 * it holds vendored screen text and where it came from, or the gate fails.
 * Everything else, the engine beside it included, is still read.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const RULES = "src/shared/agents/detect/rules";
const HEADER =
  "/**\n * vendored-screen-text: herdr src/detect/manifests/x.toml\n */\n";
const FLAGGED = 'export const X = ["waiting for user confirmation"];\n';

let repo = "";
const git = (...a: string[]) =>
  spawnSync("git", a, { cwd: repo, encoding: "utf8" });

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "words-")));
  fs.mkdirSync(path.join(repo, "scripts"));
  for (const f of ["words-gate.mjs", "words.js"])
    fs.copyFileSync(
      path.join(ROOT, "scripts", f),
      path.join(repo, "scripts", f),
    );
  fs.mkdirSync(path.join(repo, RULES), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "keep.ts"), "export {};\n");
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "base",
  );
});
afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

/** The gate's verdict on one commit over the base that adds `files`. */
function gate(files: Record<string, string>) {
  git("checkout", "-q", "--detach", "HEAD");
  const base = git("rev-parse", "HEAD").stdout.trim();
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  git("add", "-A");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "change",
  );
  const r = spawnSync(process.execPath, ["scripts/words-gate.mjs"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, DEN_WORDS_BASE: base },
  });
  // Back to the base, the files gone, for the next case.
  git("checkout", "-q", base);
  for (const f of Object.keys(files))
    fs.rmSync(path.join(repo, f), { force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("words gate: vendored screen text", () => {
  it("a flagged string in a rules file with the header passes", () => {
    expect(gate({ [`${RULES}/x.ts`]: HEADER + FLAGGED }).code).toBe(0);
  });

  it("a rules file without the header fails, naming it", () => {
    const r = gate({ [`${RULES}/x.ts`]: FLAGGED });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${RULES}/x.ts`);
    expect(r.out).toContain("vendored-screen-text");
  });

  it("the same string anywhere else still fails, the engine beside the rules too", () => {
    for (const f of [
      "src/shared/agents/detect/engine.ts",
      "src/shared/agents/detect/rules-not.ts",
      "src/ui/x.ts",
    ]) {
      const r = gate({ [f]: HEADER + FLAGGED });
      expect([f, r.code]).toEqual([f, 1]);
    }
  });
});
