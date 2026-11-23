/**
 * Hardening (issue 362): the api_only guardrail judges a path by where it
 * really is, not only by how it is spelled. A link that leads into a
 * protected folder is that folder; a protected folder named through a
 * link is matched however the agent spells it. The hook runs as Claude
 * Code runs it: a process reading the call on stdin; 2 is a deny.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao362-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const home = path.join(root, "home");
const data = path.join(root, "data");
const work = path.join(root, "work");
for (const d of [home, data, work]) fs.mkdirSync(d);
fs.writeFileSync(path.join(data, "db.sqlite"), "");
fs.writeFileSync(path.join(work, "notes.md"), "");

function rulesFor(p: string): string {
  const f = path.join(root, `rules-${path.basename(p)}.json`);
  fs.writeFileSync(
    f,
    JSON.stringify({
      services: [{ name: "vault", project: "vault", paths: [p] }],
    }),
  );
  return f;
}

function read(file_path: string, rules: string): number | null {
  const r = spawnSync(process.execPath, [HOOK, "--api-only", rules], {
    input: JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path },
      cwd: work,
    }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  return r.status;
}

describe("hardening: api_only paths by where they really are", () => {
  const rules = rulesFor(data);

  it("a link into the data folder is the data folder", () => {
    fs.symlinkSync(data, path.join(work, "shortcut"));
    expect(read(path.join(work, "shortcut", "db.sqlite"), rules)).toBe(2);
    expect(read("shortcut/db.sqlite", rules)).toBe(2);
  });

  it("a file not there yet, in a linked folder, is still inside", () => {
    fs.symlinkSync(data, path.join(work, "into"));
    expect(read(path.join(work, "into", "new.txt"), rules)).toBe(2);
  });

  it("a data path given through a link matches the real spelling", () => {
    const named = path.join(root, "named");
    fs.symlinkSync(data, named);
    expect(read(path.join(data, "db.sqlite"), rulesFor(named))).toBe(2);
  });

  it("a path outside stays outside", () => {
    expect(read(path.join(work, "notes.md"), rules)).toBe(0);
  });
});
