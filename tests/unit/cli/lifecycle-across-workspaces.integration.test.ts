/**
 * The lifecycle CLI (`setup`, `up`, `down`, `restart`) across active
 * workspaces. Only the focused workspace was resolved: a service in an
 * active but unfocused workspace made `setup` print nothing and exit 0,
 * `restart` say "not found" and `up` say "no derived dependencies".
 *
 * Now `-w <workspace>` names the workspace (setup too), and a named service
 * with no `-w` resolves across the active workspaces: the focus first, then
 * exactly one other; a name in several is an error listing them, and a
 * name in none exits 1.
 *
 * Real bin/den in a throwaway distribution: workspaces north (focus, repo
 * alpha), south (repos beta and gamma) and east (repo gamma), all active.
 * Every command a manifest declares is an `echo` of a marker, so "it ran"
 * is visible and nothing else runs; up, down and restart use --dry-run.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function den(...args: string[]): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 90_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-lcws-")));
  root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["alpha", "beta", "gamma"].map((r) => `${r}:\n  gh: acme/${r}\n`).join(""),
  );
  for (const r of ["alpha", "beta", "gamma"])
    write(
      path.join(repos, r, ".den.yml"),
      [
        `name: ${r}`,
        "services:",
        "  api:",
        "    commands:",
        "      local:",
        ...["setup", "up", "down", "restart"].map(
          (c) => `        ${c}: "echo ${c.toUpperCase()}-RAN-${r}"`,
        ),
        "",
      ].join("\n"),
    );
  const member = (r: string) => [
    `      ${r}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, r)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south, east]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      ...member("alpha"),
      "  south:",
      "    services:",
      ...member("beta"),
      ...member("gamma"),
      "  east:",
      "    services:",
      ...member("gamma"),
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a service in an active workspace that isn't the focus", () => {
  it("setup <repo/svc> and setup <repo> --force run its setup (they printed nothing and exited 0)", () => {
    for (const args of [
      ["setup", "beta/api"],
      ["setup", "beta", "--force"],
    ]) {
      const r = den(...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 0]);
      expect(r.out).toMatch(/Setup: beta/);
      expect(r.out).toMatch(/in project south \(not the focus\)/);
    }
  }, 120_000);

  it("restart <repo/svc>, up <repo> and down <repo> resolve it (not 'not found', not 'no derived dependencies')", () => {
    const restart = den("restart", "beta/api", "--dry-run");
    expect(restart.code).toBe(0);
    expect(restart.out).toMatch(/Would restart: beta\/api/);
    expect(restart.out).not.toMatch(/not found/);
    const up = den("up", "beta", "--dry-run");
    expect(up.code).toBe(0);
    expect(up.out).toMatch(/Would up: beta/);
    expect(up.out).not.toMatch(/no derived dependencies/);
    const down = den("down", "beta", "--dry-run");
    expect(down.code).toBe(0);
    expect(down.out).toMatch(/Would down: beta/);
  }, 120_000);

  it("-w <workspace> names it for setup, as for up, down and restart", () => {
    const setup = den("setup", "beta/api", "-w", "south");
    expect(setup.code).toBe(0);
    expect(setup.out).toMatch(/Setup: beta/);
    const restart = den("restart", "gamma", "--dry-run", "-w", "east");
    expect(restart.code).toBe(0);
    expect(restart.out).toMatch(/Would restart: gamma/);
  }, 120_000);
});

describe("names that don't resolve to one workspace", () => {
  it("a name in several active workspaces is an error listing them (exit 1); nothing runs", () => {
    for (const cmd of ["setup", "up", "restart", "down"]) {
      const r = den(cmd, "gamma", ...(cmd === "setup" ? [] : ["--dry-run"]));
      expect([cmd, r.code]).toEqual([cmd, 1]);
      expect(r.out).toMatch(
        new RegExp(
          `"gamma" is in more than one active project: south \\(den ${cmd} gamma -w south\\), east \\(den ${cmd} gamma -w east\\)`,
        ),
      );
      expect(r.out).not.toMatch(/RAN-gamma/);
    }
  }, 180_000);

  it("a name in no active workspace exits 1 (never 0 having done nothing)", () => {
    for (const cmd of ["setup", "up", "restart", "down"]) {
      const r = den(cmd, "nope", ...(cmd === "setup" ? [] : ["--dry-run"]));
      expect([cmd, r.code]).toEqual([cmd, 1]);
      expect(r.out).toMatch(
        /"nope" is not a service in any active project \(north, south, east\)/,
      );
    }
  }, 180_000);

  it("names in different workspaces are an error; the focus still wins its own (alpha)", () => {
    const mixed = den("setup", "alpha", "beta");
    expect(mixed.code).toBe(1);
    expect(mixed.out).toMatch(
      /These names are in different projects: alpha \(north\), beta \(south\)/,
    );
    const focus = den("restart", "alpha", "--dry-run");
    expect(focus.code).toBe(0);
    expect(focus.out).toMatch(/Would restart: alpha/);
    expect(focus.out).not.toMatch(/not the focus/);
  }, 120_000);
});
