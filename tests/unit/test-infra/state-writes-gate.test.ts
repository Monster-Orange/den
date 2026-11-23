/**
 * Issue 786 clause 2: a check fails on any new plain fs.writeFileSync under
 * src/ that doesn't go through atomic-write (scripts/state-writes-gate.mjs).
 * The allow-list names a reason per entry. The script is plain Node, so each
 * run is a child Node over a temp tree; the last case runs it on this repo.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "state-writes-gate.mjs");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A temp repo with these files (path → text) and this allow-list. */
function tree(files: Record<string, string>, allow: unknown = {}): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-state-writes-"));
  tmps.push(d);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  fs.mkdirSync(path.join(d, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(d, "scripts", "state-writes-allow.json"),
    JSON.stringify(allow),
  );
  return d;
}

const run = (root: string) =>
  spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });

const PLAIN = 'import * as fs from "fs";\nfs.writeFileSync(f, "x");\n';
const SAFE =
  'import { writeFileAtomic } from "./atomic-write.js";\nwriteFileAtomic(f, "x");\n';

describe("state-writes gate", () => {
  it("fails on a plain write of a file the list doesn't name", () => {
    const r = run(tree({ "src/shared/notes.ts": PLAIN }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/shared/notes.ts: 1 plain whole-file write");
  });

  it("passes writes through atomic-write, and atomic-write itself", () => {
    const r = run(
      tree({
        "src/shared/notes.ts": SAFE,
        "src/shared/atomic-write.ts": PLAIN,
      }),
    );
    expect(r.status).toBe(0);
  });

  it("an entry allows its count, and one more write fails", () => {
    const allow = {
      "src/ui/open.ts": { count: 1, reason: "a temp .command script" },
    };
    expect(run(tree({ "src/ui/open.ts": PLAIN }, allow)).status).toBe(0);
    const r = run(tree({ "src/ui/open.ts": PLAIN + PLAIN }, allow));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("2 plain whole-file write(s), 1 allowed");
  });

  it("an async whole-file write counts too: fs.promises.writeFile, writeFile from fs/promises", () => {
    const ns =
      'import * as fs from "fs";\nawait fs.promises.writeFile(f, "x");\n';
    const named =
      'import { mkdir, writeFile } from "fs/promises";\nawait writeFile(f, "x");\n';
    const r = run(tree({ "src/a.ts": ns, "src/b.ts": named }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/a.ts: 1 plain whole-file write(s)");
    expect(r.stderr).toContain("src/b.ts: 1 plain whole-file write(s)");
  });

  it("appends, and a local function named writeFile, never count", () => {
    const r = run(
      tree({
        "src/log.ts":
          'import * as fs from "fs";\nfs.appendFileSync(f, "line\\n");\n',
        "src/own.ts":
          "function writeFile(d: string) { return d; }\nwriteFile(dir);\n",
      }),
    );
    expect(r.status).toBe(0);
  });

  it("tests and comments never count", () => {
    const r = run(
      tree({
        "src/shared/notes.test.ts": PLAIN,
        "src/shared/doc.ts": "// a plain fs.writeFileSync(f) empties it\n",
      }),
    );
    expect(r.status).toBe(0);
  });

  it("an entry with no reason is a bad list (exit 2)", () => {
    const r = run(
      tree({ "src/a.ts": PLAIN }, { "src/a.ts": { count: 1, reason: "" } }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("needs a reason");
  });

  it("an entry that allows more than the file has is noted, not failed", () => {
    const r = run(
      tree(
        { "src/a.ts": SAFE },
        { "src/a.ts": { count: 2, reason: "was a temp file" } },
      ),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/a.ts allows 2 plain write(s) and has 0");
  });

  it("this repo passes", () => {
    const r = run(ROOT);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
