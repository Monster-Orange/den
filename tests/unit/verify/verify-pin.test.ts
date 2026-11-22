/**
 * Issue 964: the real commit pin. A scheduled command runs from a copy of
 * the allowed commit's files: later edits, committed or not, don't reach it.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { realPin } from "../../../src/shared/verify/pin.js";

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "den-pin-repo-"));
  g(r, "init", "-q");
  g(r, "config", "user.email", "t@example.com");
  g(r, "config", "user.name", "t");
  g(r, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(r, "scripts"));
  fs.writeFileSync(path.join(r, "scripts/speed.sh"), "echo allowed\n");
  fs.writeFileSync(path.join(r, "scripts/helper.sh"), "echo helper\n");
  g(r, "add", ".");
  g(r, "commit", "-q", "-m", "one");
  return r;
}

describe("issue 964: commit pin", () => {
  it("the tree holds the allowed commit's files, whatever changes after", () => {
    const r = repo();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "den-pin-state-"));
    const sha = g(r, "rev-parse", "HEAD");
    // A script the command calls changes, committed, then again uncommitted.
    fs.writeFileSync(path.join(r, "scripts/helper.sh"), "curl evil\n");
    g(r, "commit", "-q", "-am", "two");
    fs.writeFileSync(path.join(r, "scripts/helper.sh"), "rm -rf x\n");
    const dir = realPin.tree(state, "north", r, sha);
    expect(fs.readFileSync(path.join(dir, "scripts/helper.sh"), "utf-8")).toBe(
      "echo helper\n",
    );
    expect(fs.readFileSync(path.join(dir, "scripts/speed.sh"), "utf-8")).toBe(
      "echo allowed\n",
    );
    expect(dir.startsWith(state)).toBe(true);
    // Made fresh each time: a change to the folder doesn't last.
    fs.writeFileSync(path.join(dir, "scripts/helper.sh"), "tampered\n");
    expect(realPin.tree(state, "north", r, sha)).toBe(dir);
    expect(fs.readFileSync(path.join(dir, "scripts/helper.sh"), "utf-8")).toBe(
      "echo helper\n",
    );
    expect(
      fs.readdirSync(path.dirname(dir)).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
    expect(() => realPin.tree(state, "north", r, "not-a-sha")).toThrow(
      /not a commit/,
    );
  });

  it("dirty: changed or untracked named files", () => {
    const r = repo();
    expect(realPin.dirty(r, ["scripts/speed.sh"])).toEqual([]);
    fs.writeFileSync(path.join(r, "scripts/speed.sh"), "echo changed\n");
    fs.writeFileSync(path.join(r, "scripts/new.sh"), "echo new\n");
    expect(
      realPin.dirty(r, ["scripts/speed.sh", "scripts/new.sh"]).sort(),
    ).toEqual(["scripts/new.sh", "scripts/speed.sh"]);
  });

  it("a commit holding a symlink is refused: it could run what it points at now", () => {
    const r = repo();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "den-pin-state-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "den-pin-out-"));
    fs.writeFileSync(path.join(outside, "x.sh"), "echo allowed\n");
    fs.rmSync(path.join(r, "scripts/helper.sh"));
    fs.symlinkSync(
      path.join(outside, "x.sh"),
      path.join(r, "scripts/helper.sh"),
    );
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "link");
    const sha = g(r, "rev-parse", "HEAD");
    expect(realPin.symlinks(r, sha)).toEqual(["scripts/helper.sh"]);
    expect(() => realPin.tree(state, "north", r, sha)).toThrow(
      /symlinks: scripts\/helper\.sh/,
    );
    // Nothing is left behind: no pin, no temp folder.
    const pins = path.join(state, "verify", "north", "pins");
    expect(fs.existsSync(pins) ? fs.readdirSync(pins) : []).toEqual([]);
  });
});
