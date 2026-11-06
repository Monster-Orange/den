/**
 * ORG-1a on the CLI, with the real bin/den (no TTY) in throwaway
 * distributions:
 *   - `setup --plan` prints each repo's resolved org and clone URL and
 *     changes nothing: on a fresh machine it plans the blueprint (a client
 *     workspace's `org:` gives its own owner), seeded it plans the focused
 *     workspace. No clone, no gh, no catalog or workspaces.yml written.
 *   - `up --plan` adds the same repo / clone URL lines, also read-only.
 *   - `org list` shows each org's label, workspaces and the default;
 *     `workspace list` has an ORG column and `--org` filters it; org rule
 *     breaks are warnings in both (C1), never errors.
 *
 * git, gh, op, doppler, mkcert and docker are shims that record every call.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const SHIMMED = ["git", "gh", "op", "doppler", "mkcert", "docker"];
let tmp = "";

const shimDir = () => path.join(tmp, "shim");
const callLog = () => path.join(tmp, "calls.log");
/** Recorded calls, minus the git reads Den's own telemetry makes. */
const calls = (): string[] =>
  (fs.existsSync(callLog())
    ? fs.readFileSync(callLog(), "utf-8").split("\n").filter(Boolean)
    : []
  ).filter(
    (c) =>
      !/^git (config user\.name|rev-parse --abbrev-ref HEAD|rev-parse --short HEAD)$/.test(
        c,
      ),
  );

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const CONFIG = [
  "environments: [local]",
  "github_org: acme",
  "orgs:",
  '  globex: { label: Globex Corp, color: "#0af" }',
  "defaults:",
  "  workspaces:",
  "    main:",
  "      repos: [acme-api, acme-web]",
  "      focus: true",
  "    client:",
  "      org: globex",
  "      repos: [globex-web]",
  "",
].join("\n");

function makeRoot(name: string, config = CONFIG): string {
  const root = path.join(tmp, name);
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), config);
  return root;
}

function den(
  root: string,
  args: string[],
): { out: string; code: number | null } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"], // no TTY
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(root, "state"),
      DEN_DAEMONS_FILE: path.join(root, "daemons.json"),
      PATH: `${shimDir()}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
}

/**
 * Every file under config/ and the clone dir, with size and mtime. The
 * derived graph's own cache (written by any graph read, `up --plan`
 * included, before this change too) is not config and is left out.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === ".graph-cache.json") continue;
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[p] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(path.join(root, "config"));
  walk(path.join(root, ".den-services"));
  return out;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-org-cli-"));
  fs.mkdirSync(shimDir());
  for (const name of SHIMMED)
    fs.writeFileSync(
      path.join(shimDir(), name),
      `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(callLog())}\n`,
      { mode: 0o755 },
    );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("setup --plan", () => {
  it("on a fresh machine: the blueprint's orgs and clone URLs, nothing cloned or written", () => {
    const root = makeRoot("fresh");
    const before = snapshot(root);
    const n = calls().length;
    const { out, code } = den(root, ["setup", "--plan"]);
    expect(code).toBe(0);
    expect(out).toContain("From the blueprint: nothing is set up yet.");
    expect(out).toMatch(/Workspace main {2}org: acme \(default\)/);
    expect(out).toMatch(
      /acme-api {2}managed main {2}org: acme {2}https:\/\/github\.com\/acme\/acme-api\.git {2}would clone/,
    );
    expect(out).toMatch(/Workspace client {2}org: globex \(blueprint\)/);
    expect(out).toMatch(
      /globex-web {2}managed main {2}org: globex {2}https:\/\/github\.com\/globex\/globex-web\.git {2}would clone/,
    );
    expect(out).toContain("Plan only: nothing was cloned, seeded or written.");
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".den-services"))).toBe(false);
    expect(fs.existsSync(path.join(root, "config", "local"))).toBe(false);
  }, 60_000);

  it("once seeded: the focused workspace, and up --plan lists the same URLs; nothing cloned", () => {
    const root = makeRoot("seeded");
    expect(den(root, ["workspace", "seed"]).code).toBe(0);
    const before = snapshot(root);
    const n = calls().length;

    const setup = den(root, ["setup", "--plan"]);
    expect(setup.code).toBe(0);
    expect(setup.out).not.toContain("From the blueprint");
    expect(setup.out).toMatch(/Workspace main {2}org: acme/);
    expect(setup.out).toContain("https://github.com/acme/acme-web.git");
    // The client workspace is not planned, only named in the hint (0.2.8).
    expect(setup.out).not.toMatch(/Workspace client/);
    expect(setup.out).not.toMatch(/globex-web {2}managed/);
    expect(setup.out).toContain(
      "Not in this plan: 1 repo in other workspaces: client (globex-web).",
    );

    const up = den(root, ["up", "-a", "--plan"]);
    expect(up.code).toBe(0);
    expect(up.out).toContain("Repos and clone URLs:");
    expect(up.out).toMatch(
      /acme-api {2}managed main {2}org: acme {2}https:\/\/github\.com\/acme\/acme-api\.git {2}would clone/,
    );

    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".den-services"))).toBe(false);
  }, 90_000);

  it("rejects a typo'd flag instead of running setup", () => {
    const root = makeRoot("typo");
    const n = calls().length;
    const { out, code } = den(root, ["setup", "--paln"]);
    expect(out).toMatch(/Unknown flag for 'setup': --paln/);
    expect(code).toBe(1);
    expect(calls().slice(n)).toEqual([]);
  }, 60_000);
});

describe("setup --plan picks its workspaces (0.2.8)", () => {
  /**
   * A seeded machine: main (focused, with a dev-managed checkout on a
   * feature branch), client (active) and spare (inactive).
   */
  function machine(): { root: string; mine: string } {
    const root = makeRoot(
      `pick-${Math.random().toString(36).slice(2)}`,
      ["environments: [local]", "github_org: acme", ""].join("\n"),
    );
    // A checkout Den doesn't manage: its branch is read from .git/HEAD.
    const mine = path.join(root, "checkouts", "mine");
    write(path.join(mine, ".git", "HEAD"), "ref: refs/heads/feature/plan-w\n");
    write(
      path.join(root, "config", "local", "service-catalog.yml"),
      [
        "acme-api: { gh: acme/acme-api }",
        "mine: { gh: acme/mine }",
        "globex-web: { gh: globex/globex-web }",
        "spare-api: { gh: acme/spare-api }",
        "",
      ].join("\n"),
    );
    write(
      path.join(root, "config", "local", "workspaces.yml"),
      [
        "active: [main, client]",
        "focus: main",
        "workspaces:",
        "  main:",
        "    services:",
        "      acme-api:",
        "        mode: managed",
        "      mine:",
        "        mode: dev-managed",
        `        path: ${mine}`,
        "  client:",
        "    services:",
        "      globex-web:",
        "        mode: managed",
        "  spare:",
        "    services:",
        "      spare-api:",
        "        mode: managed",
        "",
      ].join("\n"),
    );
    return { root, mine };
  }

  it("the focused workspace, a dev-managed repo's real branch, and a hint for the rest", () => {
    const { root } = machine();
    const n = calls().length;
    const { out, code } = den(root, ["setup", "--plan"]);
    expect(code).toBe(0);
    expect(out).toMatch(/Workspace main {2}org: acme/);
    expect(out).toMatch(/mine {2}dev-managed feature\/plan-w {2}org: acme/);
    expect(out).not.toMatch(/Workspace (client|spare)/);
    expect(out).toContain(
      "Not in this plan: 2 repos in other workspaces: client (globex-web), spare (spare-api). Plan them with -w <workspace> or --all-workspaces.",
    );
    expect(calls().slice(n)).toEqual([]);
  }, 60_000);

  it("-w (repeatable) plans the named workspaces, on this machine or not", () => {
    const { root } = machine();
    const { out, code } = den(root, [
      "setup",
      "--plan",
      "-w",
      "client",
      "--workspace=spare",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/Workspace client {2}org: globex/);
    expect(out).toMatch(/Workspace spare {2}org: acme/);
    expect(out).toContain("https://github.com/acme/spare-api.git");
    expect(out).not.toMatch(/Workspace main/);
    expect(out).toContain(
      "Not in this plan: 2 repos in other workspaces: main (acme-api, mine).",
    );
  }, 60_000);

  it.each(["--all-workspaces", "--all-active"])(
    "%s plans every workspace on this machine (--all-active: its 0.2.8 name)",
    (flag) => {
      const { root } = machine();
      const { out, code } = den(root, ["setup", "--plan", flag]);
      expect(code).toBe(0);
      expect(out).toMatch(/Workspace main {2}org: acme/);
      expect(out).toMatch(/Workspace client {2}org: globex/);
      expect(out).not.toMatch(/Workspace spare/);
      expect(out).toContain(
        "Not in this plan: 1 repo in other workspaces: spare (spare-api).",
      );
    },
    60_000,
  );

  it("an unknown -w is an error; more than one -w without --plan is refused, setting nothing up", () => {
    const { root } = machine();
    const before = snapshot(root);
    const n = calls().length;
    const bad = den(root, ["setup", "--plan", "-w", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(
      "no workspace named nope (workspaces: main, client, spare)",
    );
    const real = den(root, ["setup", "-w", "client", "-w", "spare"]);
    expect(real.code).toBe(1);
    expect(real.out).toContain(
      "More than one -w, and --all-workspaces, go with --plan",
    );
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  }, 60_000);

  it("on a fresh machine -w narrows the blueprint's plan", () => {
    const root = makeRoot(`fresh-w-${Math.random().toString(36).slice(2)}`);
    const { out, code } = den(root, ["setup", "--plan", "-w", "client"]);
    expect(code).toBe(0);
    expect(out).toMatch(/Workspace client {2}org: globex \(blueprint\)/);
    expect(out).not.toMatch(/Workspace main/);
  }, 60_000);
});

describe("up --plan resolving nothing exits 1 (0.2.8)", () => {
  it("a name nothing resolves, and a workspace with nothing in it", () => {
    const root = makeRoot(
      `up-none-${Math.random().toString(36).slice(2)}`,
      ["environments: [local]", "github_org: acme", ""].join("\n"),
    );
    write(
      path.join(root, "config", "local", "workspaces.yml"),
      [
        "active: [main]",
        "focus: main",
        "workspaces:",
        "  main:",
        "    services: {}",
        "",
      ].join("\n"),
    );
    const n = calls().length;
    const named = den(root, ["up", "--plan", "no-such-repo"]);
    expect(named.code).toBe(1);
    const all = den(root, ["up", "-a", "--plan"]);
    expect(all.out).toContain("nothing to start");
    expect(all.code).toBe(1);
    expect(calls().slice(n)).toEqual([]);
  }, 60_000);
});

describe("register with no terminal (0.2.8)", () => {
  it("exits 2 with one usage line that names -w", () => {
    const root = makeRoot(`reg-${Math.random().toString(36).slice(2)}`);
    const { out, code } = den(root, ["register"]);
    expect(code).toBe(2);
    expect(out.trim()).toBe(
      "register needs a terminal (stdin is not a TTY); without one: den register <path> [--name <repo>] [--gh <owner/repo>] [-w <workspace>]",
    );
  }, 60_000);
});

describe("register <path> -w (0.2.8)", () => {
  it("writes the named workspace, inactive, and leaves focus alone", () => {
    const root = makeRoot(
      `reg-w-${Math.random().toString(36).slice(2)}`,
      ["environments: [local]", "github_org: acme", ""].join("\n"),
    );
    const wsFile = path.join(root, "config", "local", "workspaces.yml");
    write(
      wsFile,
      [
        "active: [main]",
        "focus: main",
        "workspaces:",
        "  main:",
        "    services: {}",
        "  spare:",
        "    services: {}",
        "",
      ].join("\n"),
    );
    const blog = path.join(root, "checkouts", "blog");
    fs.mkdirSync(blog, { recursive: true });
    const { out, code } = den(root, ["register", blog, "-w", "spare"]);
    expect(code).toBe(0);
    expect(out).toContain('Added to workspace "spare"');
    const text = fs.readFileSync(wsFile, "utf-8");
    expect(text).toMatch(/focus: main/);
    expect(text).toMatch(/active:\s*\n?\s*-?\s*\[?main\]?/);
    expect(text).toMatch(/spare:\s*\n\s+services:\s*\n\s+blog:/);
  }, 60_000);
});

describe("org list and workspace list", () => {
  /** A seeded machine: a mixed workspace, and one naming an unknown org. */
  function machine(): string {
    const root = makeRoot(
      `lists-${Math.random().toString(36).slice(2)}`,
      [
        "environments: [local]",
        "github_org: acme",
        "orgs:",
        "  globex: { label: Globex Corp }",
        "",
      ].join("\n"),
    );
    write(
      path.join(root, "config", "local", "service-catalog.yml"),
      [
        "acme-api: { gh: acme/acme-api }",
        "globex-web: { gh: Globex/globex-web }",
        "loose: { gh: '' }",
        "",
      ].join("\n"),
    );
    const svc = (...repos: string[]) =>
      repos.flatMap((r) => [`      ${r}:`, "        mode: managed"]);
    write(
      path.join(root, "config", "local", "workspaces.yml"),
      [
        "active: [main, client, mixed, odd]",
        "focus: main",
        "workspaces:",
        "  main:",
        "    services:",
        ...svc("acme-api", "loose"),
        "  client:",
        "    services:",
        ...svc("globex-web"),
        "  mixed:",
        "    services:",
        ...svc("acme-api", "globex-web"),
        "  odd:",
        "    org: example-org",
        "    services: {}",
        "",
      ].join("\n"),
    );
    return root;
  }

  it("org list: label, workspaces, default and the warnings", () => {
    const root = machine();
    const { out, code } = den(root, ["org", "list"]);
    expect(code).toBe(0);
    const row = (id: string) =>
      out.split("\n").find((l) => new RegExp(`│ ${id} +│`).test(l)) ?? "";
    expect(row("globex")).toMatch(/Globex Corp +│ +│ client +│/);
    expect(row("acme")).toMatch(/│ ✓ +│ main, mixed +│/);
    expect(row("example-org")).toMatch(/│ odd +│/);
    expect(out).toContain(
      "⚠ workspace mixed: its repos belong to several owners (acme, Globex); using acme",
    );
    expect(out).toContain(
      "⚠ workspace odd: org example-org is not in orgs:, the catalog or github_org",
    );
  }, 60_000);

  it("workspace list: an ORG column, --org filters (case-insensitively), warnings stay warnings", () => {
    const root = machine();
    const all = den(root, ["workspace", "list"]);
    expect(all.code).toBe(0);
    expect(all.out).toMatch(/│ Workspace +│ Org +│ On this machine/);
    expect(all.out).toMatch(/│ client +│ globex +│/);
    expect(all.out).toMatch(/│ mixed +│ acme +│/);
    expect(all.out).toContain("⚠ workspace mixed:");

    const one = den(root, ["workspace", "list", "--org", "GLOBEX"]);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(/│ client +│ globex +│/);
    expect(one.out).not.toMatch(/│ (main|mixed|odd) +│/);
    expect(one.out).not.toContain("⚠ workspace mixed:");
  }, 60_000);
});
