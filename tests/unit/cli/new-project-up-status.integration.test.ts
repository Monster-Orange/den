/**
 * Issue 291, items 1 and 2, through the real bin shim of a throwaway
 * distribution, on a scratch HOME.
 *
 * 1. A project made with `workspace create` is not active. `up` in it
 *    (`-w <project>`) makes it active, says so in one line, and starts it;
 *    it no longer stops with "is not active". A dry run says it would.
 * 2. `status <repo>` answers for that repo only. For a repo that runs
 *    nothing and is shared between two projects, `status <repo> -w
 *    <second project>` prints the same one line as in the first project,
 *    not the second project's whole table.
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

const active = (): string[] =>
  (
    parseYaml(
      fs.readFileSync(
        path.join(dist, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ) as { active: string[] }
  ).active;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-newup-")));
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
  const cfg = gitRepo("cfg", { "README.md": "# config only\n" });
  const shop = gitRepo("shop", { Makefile: "up:\n\t@true\n" });
  // north: cfg only. south: cfg (shared) and shop.
  for (const [repo, ws, extra] of [
    [cfg, "north", ["--no-run"]],
    [cfg, "south", ["--no-run"]],
    [shop, "south", []],
  ] as const) {
    const r = acme("repo", "add", repo, "-w", ws, ...extra, "--json");
    if (r.code !== 0) throw new Error(`repo add ${repo} -w ${ws}: ${r.out}`);
  }
}, 240_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 291 item 1: up in a project just created", () => {
  it("workspace create makes a project that is not active", () => {
    const r = acme("workspace", "create", "fresh");
    expect(r.code).toBe(0);
    expect(active()).not.toContain("fresh");
    const add = acme(
      "repo",
      "add",
      path.join(tmp, "repos", "cfg"),
      "-w",
      "fresh",
      "--no-run",
      "--json",
    );
    expect(add.code).toBe(0);
    expect(active()).not.toContain("fresh");
  }, 120_000);

  it("a dry run of up says it would make the project active, and changes nothing", () => {
    const r = acme("up", "-a", "-w", "fresh", "--dry-run");
    expect(r.out).not.toMatch(/is not active/);
    expect(r.out).toMatch(/Would make project "fresh" active/);
    expect(r.code).toBe(0);
    expect(active()).not.toContain("fresh");
  }, 120_000);

  it("up -w <new project> makes it active, says so in one line, and is ok", () => {
    const r = acme("up", "-a", "-w", "fresh", "--json");
    expect(r.out).not.toMatch(/is not active/);
    expect(r.json).toMatchObject({
      ok: true,
      workspace: "fresh",
      activated: "fresh",
      services: [],
      noRuntime: [{ repo: "cfg", why: "runs nothing" }],
    });
    expect(r.code).toBe(0);
    expect(
      r.out.match(/Made project "fresh" active to start it\./g),
    ).toHaveLength(1);
    expect(active()).toContain("fresh");
    // Once active, up says nothing about it.
    const again = acme("-w", "fresh", "up", "-a");
    expect(again.code).toBe(0);
    expect(again.out).not.toMatch(/Made project/);
  }, 120_000);
});

describe("issue 291 item 2: status <repo> for a shared repo that runs nothing", () => {
  const oneLine =
    /No services to check: cfg \(runs nothing\) has no runtime of its own\./;

  it("in the first project: the one line", () => {
    const s = acme("status", "cfg", "-w", "north");
    expect(s.out).toMatch(oneLine);
    expect(s.out).not.toMatch(/│/);
    expect(s.code).toBe(0);
  }, 120_000);

  it("in the second project: the same one line, not the project's table", () => {
    const s = acme("status", "cfg", "-w", "south");
    expect(s.out).toMatch(oneLine);
    expect(s.out).not.toMatch(/│/);
    expect(s.out).not.toMatch(/\bshop\b/);
    expect(s.code).toBe(0);
  }, 120_000);

  it("status <repo> of a repo that runs something shows its row only", () => {
    const s = acme("status", "shop", "-w", "south");
    expect(s.out).toMatch(/│ shop\b/);
    expect(s.out).not.toMatch(/\bcfg\b/);
  }, 120_000);

  it("status <repo> of a repo not in the project says so and exits 1", () => {
    const s = acme("status", "shop", "-w", "north");
    expect(s.out).toMatch(/shop is not in project north/);
    expect(s.code).toBe(1);
  }, 120_000);
});
