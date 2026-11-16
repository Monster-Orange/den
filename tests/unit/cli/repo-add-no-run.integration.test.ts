/**
 * Issue 277: a repo that runs nothing (config, docs, rulesets, shared CI)
 * is added to a project like any other, through the real bin shim of a
 * throwaway distribution, on a scratch HOME.
 *
 * - The issue's repro: a git repo with only a README. Den can't tell how
 *   it starts, and its question offers "it runs nothing" as a choice.
 * - `repo add --no-run` (or `--run "it runs nothing"`, the choice as
 *   picked) adds it with an empty service list: a side-car with
 *   `services: {}`, the repo untouched.
 * - A repo's own manifest with `services: []` is accepted.
 * - A repo added earlier with the old workaround (`--run "true"`) keeps
 *   its fake service: a re-add with --no-run says how to change it and
 *   changes nothing.
 * - A shared repo, such as one holding shared components, joins more than
 *   one project; removing it from one leaves the other's entry.
 * - Downstream: up, down, status and doctor say nothing to start and
 *   nothing unhealthy for it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  runningDenVersion,
  writeDistribution,
} from "../../../src/ui/cli/create.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let dist = "";
let env: NodeJS.ProcessEnv = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function acme(...args: string[]): { code: number; json: any; out: string } {
  const r = spawnSync(path.join(dist, "bin", "acme"), args, {
    cwd: dist,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = { unparsed: r.stdout };
  }
  return { code: r.status ?? -1, json, out: `${r.stdout}\n${r.stderr}` };
}

function gitRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, rel), text);
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      { cwd: dir, env, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

const sidecar = (repo: string) =>
  path.join(dist, "manifests", `${repo}.acme.yml`);

const readWs = () =>
  parseYaml(
    fs.readFileSync(
      path.join(dist, "config", "local", "workspaces.yml"),
      "utf-8",
    ),
  ) as {
    workspaces: Record<
      string,
      { services: Record<string, Record<string, string>> }
    >;
  };

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-norun-")));
  dist = path.join(tmp, "acme");
  writeDistribution(dist, {
    name: "acme",
    denVersion: runningDenVersion(ENGINE),
  });
  fs.mkdirSync(path.join(dist, "node_modules", "@monster-orange"), {
    recursive: true,
  });
  fs.symlinkSync(
    ENGINE,
    path.join(dist, "node_modules", "@monster-orange", "den"),
  );
  for (const [k, v] of Object.entries(process.env))
    if (!/^(DEN_(?!LOGIN_SHELL$|RUNTIME_DIRS$)|ACME_)/.test(k)) env[k] = v;
  env = {
    ...env,
    HOME: path.join(tmp, "home"),
    ACME_HOME: path.join(tmp, "acme-home"),
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  fs.mkdirSync(path.join(tmp, "home"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("repo add: a repo that runs nothing (issue 277)", () => {
  it("the repro: a README-only repo's question offers 'it runs nothing', which maps to --no-run", () => {
    const repo = gitRepo("cfg", { "README.md": "# config only\n" });
    const r = acme("repo", "add", repo, "-w", "north", "--dry-run", "--json");
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      ok: false,
      error: `Den could not tell how ${repo} starts`,
      ask: expect.stringMatching(/run nothing/),
      choices: ["it runs nothing"],
      fix: `./bin/acme repo add ${repo} --no-run --json`,
    });
    expect(fs.existsSync(sidecar("cfg"))).toBe(false);

    const dry = acme(
      "repo",
      "add",
      repo,
      "-w",
      "north",
      "--no-run",
      "--dry-run",
      "--json",
    );
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({
      ok: true,
      dryRun: true,
      services: [],
      manifest: { source: "sidecar", detected: "--no-run" },
    });
    expect(parseYaml(dry.json.draft)).toEqual({
      version: 1,
      name: "cfg",
      services: {},
    });
    expect(fs.existsSync(sidecar("cfg"))).toBe(false);
  }, 120_000);

  it("--no-run adds it with an empty service list; a re-run is existed", () => {
    const repo = path.join(tmp, "repos", "cfg");
    const r = acme("repo", "add", repo, "-w", "north", "--no-run", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      existed: false,
      repo: "cfg",
      workspace: "north",
      services: [],
      manifest: { source: "sidecar", written: true, detected: "--no-run" },
    });
    // Nothing to start: next never says `up`.
    expect(r.json.next.join(" ")).not.toMatch(/ up cfg/);
    expect(parseYaml(fs.readFileSync(sidecar("cfg"), "utf-8"))).toEqual({
      version: 1,
      name: "cfg",
      services: {},
    });
    expect(readWs().workspaces.north.services.cfg).toEqual({
      mode: "dev-managed",
      path: repo,
    });
    const again = acme("repo", "add", repo, "-w", "north", "--json");
    expect(again.json).toMatchObject({ ok: true, existed: true, services: [] });
  }, 120_000);

  it('the choice as picked (--run "it runs nothing") is --no-run; --no-run with --run or --health is refused', () => {
    const repo = gitRepo("rules", { "README.md": "# rulesets\n" });
    const both = acme(
      "repo",
      "add",
      repo,
      "--no-run",
      "--run",
      "make up",
      "--json",
    );
    expect(both.code).toBe(1);
    expect(both.json.error).toMatch(/--no-run.*--run|--run.*--no-run/);
    const health = acme(
      "repo",
      "add",
      repo,
      "--no-run",
      "--health",
      "http://localhost:47992/",
      "--json",
    );
    expect(health.code).toBe(1);
    expect(health.json.error).toMatch(/--health/);
    const picked = acme(
      "repo",
      "add",
      repo,
      "-w",
      "north",
      "--run",
      "it runs nothing",
      "--json",
    );
    expect(picked.code).toBe(0);
    expect(picked.json).toMatchObject({ ok: true, services: [] });
    expect(parseYaml(fs.readFileSync(sidecar("rules"), "utf-8"))).toEqual({
      version: 1,
      name: "rules",
      services: {},
    });
  }, 120_000);

  it("a repo's own manifest with services: [] is accepted", () => {
    const repo = gitRepo("docs", {
      ".acme.yml": "version: 1\nname: docs\nservices: []\n",
    });
    const v = spawnSync(path.join(dist, "bin", "acme"), ["validate", repo], {
      cwd: dist,
      env,
      encoding: "utf-8",
    });
    expect(`${v.stdout}${v.stderr}`).toMatch(/no issues/);
    expect(v.status).toBe(0);
    const r = acme("repo", "add", repo, "-w", "north", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      services: [],
      manifest: { source: "repo" },
    });
  }, 120_000);

  it('the old workaround (--run "true") keeps its fake service; --no-run on it changes nothing and says how', () => {
    const repo = gitRepo("ci", { "README.md": "# shared CI\n" });
    const old = acme("repo", "add", repo, "-w", "north", "--run", "true");
    expect(old.code).toBe(0);
    const before = fs.readFileSync(sidecar("ci"), "utf-8");
    const again = acme("repo", "add", repo, "-w", "north", "--json");
    expect(again.json).toMatchObject({
      ok: true,
      existed: true,
      services: ["ci"],
    });
    const no = acme("repo", "add", repo, "-w", "north", "--no-run", "--json");
    expect(no.code).toBe(1);
    expect(no.json.error).toMatch(/already runs ci/);
    expect(no.json.fix ?? "").toContain(sidecar("ci"));
    expect(fs.readFileSync(sidecar("ci"), "utf-8")).toBe(before);
  }, 120_000);
});

describe("a shared repo, such as one holding shared components, in more than one project", () => {
  it("joins two projects; each has its own entry", () => {
    const cfg = path.join(tmp, "repos", "cfg");
    const r = acme("repo", "add", cfg, "-w", "south", "--no-run", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, existed: false, services: [] });
    // A repo with services shared the same way.
    const shop = gitRepo("shop", {
      Makefile: "up:\n\t@true\n",
    });
    for (const ws of ["north", "south"])
      expect(acme("repo", "add", shop, "-w", ws, "--json").code).toBe(0);
    const w = readWs().workspaces;
    for (const ws of ["north", "south"]) {
      expect(w[ws].services.cfg).toEqual({ mode: "dev-managed", path: cfg });
      expect(w[ws].services.shop).toEqual({ mode: "dev-managed", path: shop });
    }
  }, 120_000);
});

describe("downstream: nothing to start, nothing unhealthy", () => {
  it("up and down of a repo that runs nothing are ok, with nothing started", () => {
    const up = acme("-w", "north", "up", "cfg", "--json");
    expect(up.json).toMatchObject({ ok: true, services: [] });
    expect(up.json.runsNothing).toEqual(["cfg"]);
    expect(up.code).toBe(0);
    const down = acme("-w", "north", "down", "cfg", "--json");
    expect(down.code).toBe(0);
    expect(down.json).toMatchObject({ ok: true, services: [] });
  }, 120_000);

  it("status lists no service for it, and no unknown or unhealthy row", () => {
    const s = acme("status", "--all-active");
    expect(s.out).not.toMatch(/│ cfg\b/);
    expect(s.out).not.toMatch(/│ rules\b/);
    expect(s.out).not.toMatch(/│ docs\b/);
  }, 120_000);
});
