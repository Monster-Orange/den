/**
 * `repo add <path|git-url> [--sidecar] --json` (ON-2), through the real
 * bin shim of a throwaway distribution, on a scratch HOME.
 *
 * - A repo with no manifest gets a side-car in the distribution's
 *   manifests/ (the held-manifest layer), detected from its Makefile; the
 *   repo's tree is byte-identical before and after, git metadata included.
 * - Re-running answers ok with existed: true and rewrites nothing.
 * - Detection that cannot decide answers ask + choices and writes nothing;
 *   a re-run with --run "<cmd>" adds it.
 * - A repo's own manifest is used as is; --sidecar on one is an error with
 *   a fix.
 * - A git URL is cloned where Den keeps managed clones and added managed.
 * - With no workspaces file at all, a `default` workspace is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
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
function acme(...args: string[]): { code: number; json: any; err: string } {
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
  return { code: r.status ?? -1, json, err: r.stderr };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** Every path, mode and byte under `root`: equal digests, identical trees. */
function treeDigest(root: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    h.update(`${rel}\0${st.mode}\0`);
    if (st.isDirectory())
      for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e));
    else if (st.isFile()) h.update(fs.readFileSync(abs));
  };
  walk("");
  return h.digest("hex");
}

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}

const readWs = () =>
  parseYaml(
    fs.readFileSync(
      path.join(dist, "config", "local", "workspaces.yml"),
      "utf-8",
    ),
  ) as {
    active: string[];
    focus: string;
    workspaces: Record<
      string,
      { services: Record<string, Record<string, string>> }
    >;
  };

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-repoadd-")));
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

describe("repo add", () => {
  it("a repo with no manifest: a side-car in manifests/, a default workspace, the repo untouched", () => {
    const repo = makeRepo("shop", {
      Makefile: "up:\n\t@echo up\ndown:\n\t@echo down\ntest:\n\t@echo t\n",
      "README.md": "shop\n",
    });
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://example.com/acme/shop.git");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const before = treeDigest(repo);
    expect(
      fs.existsSync(path.join(dist, "config", "local", "workspaces.yml")),
    ).toBe(false);

    const r = acme(
      "repo",
      "add",
      repo,
      "--health",
      "http://localhost:47991/",
      "--json",
    );
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      existed: false,
      repo: "shop",
      workspace: "default",
      mode: "dev-managed",
      path: repo,
      manifest: {
        source: "sidecar",
        file: path.join(dist, "manifests", "shop.acme.yml"),
        written: true,
        detected: "make",
      },
      services: ["shop"],
      next: [
        "./bin/acme up shop --json",
        "./bin/acme web up --no-open --json",
        "./bin/acme doctor --json",
      ],
    });
    const side = parseYaml(
      fs.readFileSync(path.join(dist, "manifests", "shop.acme.yml"), "utf-8"),
    );
    expect(side).toEqual({
      version: 1,
      name: "shop",
      services: {
        shop: {
          commands: { local: { up: "make up", down: "make down" } },
          health: { local: { url: "http://localhost:47991/" } },
        },
      },
      tests: { unit: { cmd: "make test" } },
    });
    const ws = readWs();
    expect(ws.active).toEqual(["default"]);
    expect(ws.workspaces.default.services.shop).toEqual({
      mode: "dev-managed",
      path: repo,
    });
    expect(treeDigest(repo)).toBe(before);

    // The same manifest the validator checks, as `validate` sees it.
    const v = spawnSync(path.join(dist, "bin", "acme"), ["validate", repo], {
      cwd: dist,
      env,
      encoding: "utf-8",
    });
    expect(v.status).toBe(0);
    expect(`${v.stdout}`).toMatch(/held, v1, no issues/);
  }, 120_000);

  it("is safe to re-run: existed: true, nothing rewritten, the repo still untouched", () => {
    const repo = path.join(tmp, "repos", "shop");
    const before = treeDigest(repo);
    const side = path.join(dist, "manifests", "shop.acme.yml");
    const sideText = fs.readFileSync(side, "utf-8");
    const wsText = fs.readFileSync(
      path.join(dist, "config", "local", "workspaces.yml"),
      "utf-8",
    );
    const r = acme("repo", "add", repo, "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      existed: true,
      repo: "shop",
      manifest: { source: "sidecar", file: side, written: false },
    });
    expect(fs.readFileSync(side, "utf-8")).toBe(sideText);
    expect(
      fs.readFileSync(
        path.join(dist, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toBe(wsText);
    expect(treeDigest(repo)).toBe(before);
  }, 120_000);

  it("can't decide: ask + choices, nothing written; --run adds it", () => {
    const repo = makeRepo("web", {
      "compose.yaml": "services: {}\n",
      "package.json": JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
    });
    const before = treeDigest(repo);
    const r = acme("repo", "add", repo, "--json");
    expect(r.code).toBe(1);
    expect(r.json).toEqual({
      ok: false,
      error: `Den could not tell how ${repo} starts`,
      ask: expect.stringMatching(/2 ways/),
      choices: ["docker compose -f compose.yaml up -d", "npm run dev"],
      fix: `./bin/acme repo add ${repo} --run "docker compose -f compose.yaml up -d" --json`,
    });
    expect(fs.existsSync(path.join(dist, "manifests", "web.acme.yml"))).toBe(
      false,
    );
    expect(readWs().workspaces.default.services.web).toBeUndefined();

    const ok = acme("repo", "add", repo, "--run", "npm run dev", "--json");
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({
      ok: true,
      repo: "web",
      manifest: { written: true, detected: "--run" },
    });
    expect(
      parseYaml(
        fs.readFileSync(path.join(dist, "manifests", "web.acme.yml"), "utf-8"),
      ).services.web.commands.local,
    ).toEqual({ up: "npm run dev" });
    expect(treeDigest(repo)).toBe(before);
  }, 120_000);

  it("a repo's own manifest is used; --sidecar on it is an error with a fix", () => {
    const repo = makeRepo("api", {
      ".acme.yml":
        "name: api\nservices:\n  api:\n    commands:\n      local:\n        up: echo up\n",
    });
    const before = treeDigest(repo);
    const side = acme("repo", "add", repo, "--sidecar", "--json");
    expect(side.code).toBe(1);
    expect(side.json).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has its own manifest \(\.acme\.yml\)/),
      fix: `./bin/acme repo add ${repo} --json`,
      ask: expect.stringMatching(/override/),
    });
    const r = acme("repo", "add", repo, "-w", "team", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      repo: "api",
      workspace: "team",
      manifest: { source: "repo", file: path.join(repo, ".acme.yml") },
    });
    // -w made the workspace and activated it; the focus stayed.
    const ws = readWs();
    expect(ws.active).toEqual(["default", "team"]);
    expect(ws.focus).toBe("default");
    expect(fs.existsSync(path.join(dist, "manifests", "api.acme.yml"))).toBe(
      false,
    );
    expect(treeDigest(repo)).toBe(before);
  }, 120_000);

  it("a git URL is cloned into the managed clones and added managed; a re-run is existed", () => {
    const src = makeRepo("tasks-src", { Makefile: "up:\n\t@echo up\n" });
    git(src, "init", "-q", "-b", "trunk");
    git(src, "add", "-A");
    git(src, "commit", "-qm", "init");
    const bare = path.join(tmp, "git", "tasks.git");
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(tmp, "clone", "-q", "--bare", src, bare);
    const url = `file://${bare}`;

    const r = acme("repo", "add", url, "--json");
    expect(r.code).toBe(0);
    const clone = path.join(dist, ".acme-services", "tasks", "trunk");
    expect(r.json).toMatchObject({
      ok: true,
      existed: false,
      repo: "tasks",
      mode: "managed",
      path: clone,
      manifest: {
        source: "sidecar",
        file: path.join(dist, "manifests", "tasks.acme.yml"),
        written: true,
      },
    });
    expect(fs.existsSync(path.join(clone, "Makefile"))).toBe(true);
    expect(readWs().workspaces.default.services.tasks).toEqual({
      mode: "managed",
      branch: "trunk",
    });
    const again = acme("repo", "add", url, "--json");
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({
      ok: true,
      existed: true,
      repo: "tasks",
    });
  }, 120_000);

  it("bad input answers JSON with a fix or a question", () => {
    const missing = acme("repo", "add", path.join(tmp, "nope"), "--json");
    expect(missing.code).toBe(1);
    expect(missing.json).toMatchObject({ ok: false, ask: expect.any(String) });
    const flag = acme("repo", "add", "--bogus", "--json");
    expect(flag.code).toBe(2);
    expect(flag.json).toMatchObject({
      ok: false,
      error: "unknown flag --bogus",
      fix: "./bin/acme repo add <path|git-url> --json",
    });
  }, 120_000);
});

describe("doctor --json over the repos added above", () => {
  it("Docker is checked because a registered repo has a compose file; no web server is a fail with its fix", () => {
    // A stand-in docker whose daemon never answers, first on PATH: the
    // result never depends on this machine's Docker.
    const bin = path.join(tmp, "fake-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    // A port nothing listens on, never the default.
    fs.writeFileSync(
      path.join(dist, "config", "local", "user.yml"),
      "web:\n  port: 1\n",
    );
    const saved = env.PATH;
    env.PATH = [bin, saved].join(path.delimiter);
    try {
      const r = acme("doctor", "--json");
      expect(r.code).toBe(1);
      const byId = Object.fromEntries(
        (r.json.checks as { id: string }[]).map((c) => [c.id, c]),
      );
      expect(byId.node).toMatchObject({ status: "ok" });
      expect(byId.git).toMatchObject({ status: "ok" });
      expect(byId.docker).toMatchObject({
        status: "fail",
        detail: expect.stringMatching(
          /^web needs Docker, and the Docker daemon is not answering/,
        ),
        ask: expect.any(String),
      });
      expect(byId.web).toMatchObject({
        status: "fail",
        url: "http://localhost:1",
        fix: "./bin/acme web up --no-open --json",
      });
      expect(byId.mcp).toMatchObject({
        status: "fail",
        fix: "./bin/acme web up --no-open --json",
      });
      expect(byId["strategy:secrets"]).toMatchObject({ status: "ok" });
      expect(r.json.ok).toBe(false);
      // The human doctor is unchanged: no onboarding rows.
      const human = spawnSync(path.join(dist, "bin", "acme"), ["doctor"], {
        cwd: dist,
        env,
        encoding: "utf-8",
      });
      expect(human.stdout).toMatch(/Acme doctor: strategies/);
      expect(human.stdout).not.toMatch(/docker|web server/i);
    } finally {
      env.PATH = saved;
    }
  }, 120_000);
});
