import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const FLAGGED = 'export const X = ["waiting for user confirmation"];';
const OLD = "src/shared/old-place.ts";
const NEW = "src/shared/place/old-place.ts";

const body = (tag: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `export const v${tag}${i} = ${i} * ${i + 7} + ${i % 3};`,
  );
const BASE_TEXT = [FLAGGED, ...body("a", 20)].join("\n") + "\n";
const MOVED_TEXT =
  [FLAGGED, ...body("a", 9), ...body("b", 11)].join("\n") + "\n";

let repo = "";
const git = (...a: string[]) =>
  spawnSync("git", a, { cwd: repo, encoding: "utf8" });
const commit = (m: string) =>
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
    m,
  );

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "words-mv-")));
  fs.mkdirSync(path.join(repo, "scripts"));
  for (const f of ["words-gate.mjs", "words.js"])
    fs.copyFileSync(
      path.join(ROOT, "scripts", f),
      path.join(repo, "scripts", f),
    );
  fs.mkdirSync(path.join(repo, "src", "shared"), { recursive: true });
  fs.writeFileSync(path.join(repo, OLD), BASE_TEXT);
  git("init", "-q");
  git("add", "-A");
  commit("base");
});
afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function gateAfterMove(text: string, shim = false) {
  git("checkout", "-q", "--detach", "HEAD");
  const base = git("rev-parse", "HEAD").stdout.trim();
  if (shim)
    fs.writeFileSync(
      path.join(repo, OLD),
      'export * from "./place/old-place.js";\n',
    );
  else git("rm", "-q", OLD);
  fs.mkdirSync(path.dirname(path.join(repo, NEW)), { recursive: true });
  fs.writeFileSync(path.join(repo, NEW), text);
  git("add", "-A");
  commit("move");
  const similarity = git(
    "diff",
    "--name-status",
    "-C1%",
    base,
    "HEAD",
  ).stdout.trim();
  const r = spawnSync(process.execPath, ["scripts/words-gate.mjs"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, DEN_WORDS_BASE: base },
  });
  git("checkout", "-q", base);
  fs.rmSync(path.join(repo, "src", "shared", "place"), {
    recursive: true,
    force: true,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, similarity };
}

describe("words gate: a moved file", () => {
  it("is judged only on the lines that changed, even when git's default pairing misses it", () => {
    const r = gateAfterMove(MOVED_TEXT);
    const pct = Number(/^R0*(\d+)/.exec(r.similarity)?.[1] ?? 0);
    expect(pct).toBeGreaterThanOrEqual(30);
    expect(pct).toBeLessThan(50);
    expect(r.out).not.toContain("waiting for user confirmation");
    expect(r.code).toBe(0);
  });

  it("is judged the same when a one-line shim stays at the old path", () => {
    const r = gateAfterMove(MOVED_TEXT, true);
    expect(r.similarity).toMatch(/^C0*(3\d|4\d)\b/m);
    expect(r.out).not.toContain("waiting for user confirmation");
    expect(r.code).toBe(0);
  });

  it("still fails on a flagged string the move adds", () => {
    const r = gateAfterMove(
      MOVED_TEXT + 'export const Y = "pick a user for the session";\n',
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${NEW}:`);
    expect(r.out).toContain("pick a user for the session");
    expect(r.out).not.toContain("waiting for user confirmation");
  });
});
