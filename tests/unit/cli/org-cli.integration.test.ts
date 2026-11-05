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
    expect(setup.out).not.toContain("globex-web");

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
    expect(all.out).toMatch(/│ Workspace +│ Org +│ Active/);
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
