/**
 * ORG-1d end to end on a scratch distribution, real git, no network:
 *   - an org with no source whose repo has only a `remote:` (a local bare
 *     repo) clones and pulls through plain git: gh is never asked;
 *   - `setup --plan` shows that remote as the clone URL;
 *   - `org list` lists orgs, not the owners their sources claim, and an org
 *     spanning two GitHub owners holds both owners' workspaces;
 *   - a repo or owner claimed by two orgs is an error naming both keys.
 *
 * gh, op, doppler and mkcert are shims that log and fail; https is refused
 * (GIT_ALLOW_PROTOCOL=file), so nothing can reach a network.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const GIT = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";

let tmp = "";
let root = "";
let bare = "";
let seed = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(tmp, "shim")}:${process.env.PATH ?? ""}`,
    DEN_ROOT: root,
    DEN_HOME: path.join(tmp, "home"),
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync(GIT, args, { cwd, env: env(), encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return r.stdout.trim();
}

function den(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    { cwd: root, env: env(), encoding: "utf-8", timeout: 60_000 },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const shimCalls = (): string[] => {
  const log = path.join(tmp, "shim.log");
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean)
    : [];
};

function config(orgs: string[]): void {
  write(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "github_org: acme", "orgs:", ...orgs, ""].join(
      "\n",
    ),
  );
}

const ORGS = [
  "  acme-group:",
  "    sources:",
  "      - { host: github, owner: acme }",
  "      - { host: github, owner: acme-labs }",
  "  initech: { sources: [], repos: [widget] }",
];

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-org-clone-")),
  );
  root = path.join(tmp, "dist");
  bare = path.join(tmp, "bare", "widget.git");
  seed = path.join(tmp, "seed");
  write(
    path.join(tmp, "gitconfig"),
    "[user]\n  name = Den Test\n  email = test@localhost\n[init]\n  defaultBranch = main\n",
  );
  for (const b of ["gh", "op", "doppler", "mkcert"])
    write(
      path.join(tmp, "shim", b),
      `#!/bin/sh\necho "${b} $*" >> "${path.join(tmp, "shim.log")}"\nexit 1\n`,
      0o755,
    );

  fs.mkdirSync(seed, { recursive: true });
  git(["init", "-q"], seed);
  write(
    path.join(seed, ".den.yml"),
    "version: 1\nname: widget\nservices:\n  widget: {}\n",
  );
  git(["add", "."], seed);
  git(["commit", "-qm", "one"], seed);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(["clone", "-q", "--bare", seed, bare], tmp);

  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  config(ORGS);
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    [
      "acme-api: { gh: acme/acme-api }",
      "labs-tool: { gh: acme-labs/labs-tool }",
      `widget: { remote: ${bare} }`,
      "hooli-app: { gh: hooli/hooli-app }",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [lab, main, hooli]",
      "focus: lab",
      "workspaces:",
      "  lab:",
      "    services:",
      "      widget: { mode: managed, branch: main }",
      "  main:",
      "    services:",
      "      acme-api: { mode: managed }",
      "      labs-tool: { mode: managed }",
      "  hooli:",
      "    services:",
      "      hooli-app: { mode: managed }",
      "",
    ].join("\n"),
  );
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const clone = () => path.join(root, ".den-services", "widget", "main");

describe("an org with no source: a plain remote: clones and pulls", () => {
  it("setup --plan shows the remote as the clone URL, and clones nothing", () => {
    const r = den("setup", "--plan");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Workspace lab {2}org: initech/);
    expect(r.out).toContain(`widget  managed main  org: initech  ${bare}`);
    expect(fs.existsSync(clone())).toBe(false);
  }, 60_000);

  it("sync clones it through plain git", () => {
    const r = den("sync");
    expect(r.code).toBe(0);
    expect(git(["rev-parse", "HEAD"], clone())).toBe(
      git(["rev-parse", "HEAD"], seed),
    );
    expect(git(["config", "--get", "remote.origin.url"], clone())).toBe(bare);
    expect(shimCalls()).toEqual([]);
  }, 60_000);

  it("sync pulls a new commit through plain git", () => {
    write(path.join(seed, "CHANGES"), "two\n");
    git(["add", "."], seed);
    git(["commit", "-qm", "two"], seed);
    git(["push", "-q", bare, "main"], seed);
    const r = den("sync");
    expect(r.code).toBe(0);
    expect(git(["log", "-1", "--format=%s"], clone())).toBe("two");
    expect(shimCalls()).toEqual([]);
  }, 60_000);
});

describe("org list and discovery", () => {
  it("lists orgs, not the owners a source claims; the fallback is unchanged", () => {
    const r = den("org", "list");
    expect(r.code).toBe(0);
    const ids = [...r.out.matchAll(/^│ (\S+)\s+│/gm)].map((m) => m[1]);
    expect(ids).toEqual(["Org", "acme-group", "initech", "hooli"]);
    expect(r.out).toMatch(/│ acme-group\s+│[^\n]*│ main\s+│/);
    expect(r.out).toMatch(/│ initech\s+│[^\n]*│ lab\s+│/);
  }, 60_000);
});

describe("a claim made twice is an error naming both keys", () => {
  afterAll(() => config(ORGS));

  it("a repo listed by two orgs", () => {
    config([...ORGS, "  globex: { repos: [widget] }"]);
    const r = den("org", "list");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(
      /repo widget is claimed by both orgs\.initech\.repos and orgs\.globex\.repos/,
    );
  }, 60_000);

  it("an owner claimed by two orgs' sources", () => {
    config([
      ...ORGS,
      "  globex:",
      "    sources: [{ host: github, owner: ACME }]",
    ]);
    const r = den("org", "list");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(
      /github owner ACME is claimed by both orgs\.acme-group\.sources\[0\] and orgs\.globex\.sources\[0\]/,
    );
  }, 60_000);
});
