/**
 * ON-3's CLI twins, through the real bin shim of a throwaway distribution
 * on a scratch HOME:
 *
 * - `repo detect <folder> --json`: the repos in a folder, how each runs and
 *   the suggested workspaces (repos_detect); a folder outside home refused.
 * - `repo add <path> --dry-run --json`: the side-car draft, validated, with
 *   nothing written: the repo, manifests/ and workspaces.yml untouched
 *   (manifest_draft).
 * - `onboard status --json`: the checks and the next step (onboard_status),
 *   against a web.port nothing listens on.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  runningDenVersion,
  writeDistribution,
} from "../../../src/ui/cli/create.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let dist = "";
let home = "";
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

function digest(root: string): string {
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

function repo(rel: string, files: Record<string, string>): string {
  const dir = path.join(home, rel);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  for (const [f, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, f), text);
  return dir;
}

/** A localhost port nothing listens on (taken, then let go). */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "localhost", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-on3c-")));
  dist = path.join(tmp, "acme");
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
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
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "config", "local", "user.yml"),
    `web:\n  port: ${await freePort()}\n`,
  );
  for (const [k, v] of Object.entries(process.env))
    if (!/^(DEN_(?!LOGIN_SHELL$|RUNTIME_DIRS$)|ACME_)/.test(k)) env[k] = v;
  env = {
    ...env,
    HOME: home,
    ACME_HOME: path.join(home, ".acme"),
    // Nothing on PATH but the basics: no agent CLI can be found or run.
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  repo("code/acme", { Makefile: "up:\n\t@echo up\ndown:\n\t@echo down\n" });
  repo("code/work/north", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  fs.mkdirSync(path.join(home, "code", "node_modules", "dep", ".git"), {
    recursive: true,
  });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("repo detect", () => {
  it("lists the repos, how each runs and the suggested workspaces", () => {
    const r = acme("repo", "detect", path.join(home, "code"), "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      repos: [
        { name: "acme", depth: 1, runs: { up: "make up" }, workspace: "code" },
        {
          name: "north",
          depth: 2,
          runs: { up: "npm run dev" },
          workspace: "work",
        },
      ],
      workspaces: [
        { name: "code", repos: ["acme"] },
        { name: "work", repos: ["north"] },
      ],
    });
  });

  it("refuses a folder outside home (exit 1)", () => {
    const r = acme("repo", "detect", tmp, "--json");
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/outside your home folder/);
  });
});

describe("repo add --dry-run", () => {
  it("prints the draft, validated, and writes nothing", () => {
    const dir = path.join(home, "code", "acme");
    const before = digest(dir);
    const r = acme("repo", "add", dir, "--dry-run", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      dryRun: true,
      repo: "acme",
      manifest: {
        source: "sidecar",
        file: path.join(dist, "manifests", "acme.acme.yml"),
        written: false,
        detected: "make",
      },
      validation: { valid: true },
      next: [`./bin/acme repo add ${dir} --json`],
    });
    expect(r.json.draft).toMatch(/up: make up/);
    expect(digest(dir)).toBe(before);
    expect(fs.existsSync(path.join(dist, "manifests", "acme.acme.yml"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(dist, "config", "local", "workspaces.yml")),
    ).toBe(false);
  });

  it("a git URL is refused: it would have to be cloned", () => {
    const r = acme(
      "repo",
      "add",
      "https://example.com/acme/north.git",
      "--dry-run",
      "--json",
    );
    expect(r.code).toBe(1);
    expect(r.json.error).toMatch(/local folder/);
  });
});

describe("onboard status", () => {
  it("answers the checks and the next step: start the web server", () => {
    const r = acme("onboard", "status", "--json");
    expect(r.code).toBe(0);
    expect(r.json.checks.map((c: { id: string }) => c.id)).toEqual([
      "distribution",
      "node",
      "git",
      "docker",
      "web",
      "workspaces",
      "repos",
      "service",
      "mcp",
    ]);
    expect(r.json.checks[0]).toMatchObject({ status: "ok" });
    expect(r.json.next).toMatchObject({
      id: "web",
      command: "./bin/acme web up --no-open --json",
    });
  });
});
