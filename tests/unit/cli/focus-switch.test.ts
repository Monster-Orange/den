/**
 * WS-6.1, WS-6.2, WS-6.7, WS-6.8 from the command line: `focus` and
 * `switch` (0.4.3), and the words: a workspace is "on this machine",
 * never "(active)". The real bin/den in a throwaway distribution
 * (helpers/dist.ts: north on this machine, south not).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { makeDist, type Dist } from "../sessions/helpers/dist.js";

let dist: Dist | null = null;
const d = () => (dist ??= makeDist("den-focus-switch-"));
afterAll(() => {
  if (dist) fs.rmSync(dist.tmp, { recursive: true, force: true });
});
const wsFile = () =>
  fs.readFileSync(
    path.join(d().root, "config", "local", "workspaces.yml"),
    "utf-8",
  );

describe("focus (WS-6.1)", () => {
  it("shows the focus, and refuses a workspace not on this machine", () => {
    const r = d().den(["focus"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Focus: north");
    const bad = d().den(["focus", "south"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('workspace "south" is not on this machine');
  }, 60_000);

  it("workspace add puts it on this machine; focus --all and focus <ws> store it, starting nothing", () => {
    expect(d().den(["workspace", "add", "south"]).code).toBe(0);
    expect(wsFile()).toMatch(/active:\s*\n?\s*-?\s*\[?north,?\s*-?\s*south\]?/);
    const all = d().den(["focus", "--all"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("Focus: all workspaces");
    expect(all.out).toContain("Nothing started or stopped");
    expect(wsFile()).toMatch(/^focus: all$/m);
    expect(d().den(["focus"]).out).toContain(
      "Focus: all workspaces (north, south)",
    );
    expect(d().den(["focus", "south"]).code).toBe(0);
    expect(wsFile()).toMatch(/^focus: south$/m);
  }, 120_000);
});

describe("switch (WS-6.7, WS-6.8)", () => {
  it("--dry-run prints the plan and changes nothing", () => {
    const before = wsFile();
    const r = d().den(["switch", "north", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Switch to north: nothing else stops");
    expect(r.out).toContain("Keeps running:");
    const s = d().den(["switch", "north", "--stop-others", "-n"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("Stop & Switch to north");
    expect(s.out).toContain("--dry-run: nothing changed");
    expect(wsFile()).toBe(before);
  }, 120_000);

  it("needs one workspace on this machine", () => {
    expect(d().den(["switch"]).code).toBe(1);
    expect(d().den(["switch", "all"]).code).toBe(1);
    const r = d().den(["switch", "nowhere"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage:");
  }, 60_000);
});

describe("the words (WS-6.2)", () => {
  it("help says on this machine, never (active)", () => {
    for (const args of [
      ["--help"],
      ["workspace", "--help"],
      ["focus", "--help"],
      ["switch", "--help"],
    ]) {
      const r = d().den(args);
      expect([args.join(" "), /\(active\)/.test(r.out)]).toEqual([
        args.join(" "),
        false,
      ]);
    }
    expect(d().den(["workspace", "--help"]).out).toContain("on this machine");
    expect(d().den(["--help"]).out).toMatch(/switch <ws>/);
  }, 120_000);

  it("workspace list has an On this machine column", () => {
    expect(d().den(["workspace", "list"]).out).toContain("On this machine");
  }, 60_000);
});
