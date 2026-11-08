/**
 * ON-3's read actions, as data (onboard-reads.ts): the path rule every one
 * takes, `repos_detect`'s scan, `manifest_draft`'s draft and
 * `onboard_status`'s checks. Everything is in temp folders with invented
 * repos; nothing runs a repo's tools or a real agent CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkOnboardPath,
  manifestDraft,
  mcpRegistration,
  onboardStatus,
  reposDetect,
  type OnboardStatusDeps,
} from "../../../src/ui/cli/onboard-reads.js";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";
import { product } from "../../../src/shared/product.js";

let tmp = "";
let home = "";
let state = "";
let manifests = "";
const savedManifestsDir = process.env.DEN_MANIFESTS_DIR;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-on3-")));
  home = path.join(tmp, "home");
  state = path.join(home, ".acme");
  manifests = path.join(tmp, "dist", "manifests");
  fs.mkdirSync(state, { recursive: true });
  process.env.DEN_MANIFESTS_DIR = manifests;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedManifestsDir === undefined) delete process.env.DEN_MANIFESTS_DIR;
  else process.env.DEN_MANIFESTS_DIR = savedManifestsDir;
});

const rules = () => ({ home, stateDir: state });

/** A folder with a `.git` and the files given. */
function repo(rel: string, files: Record<string, string> = {}): string {
  const dir = path.join(home, rel);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  for (const [f, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, f), text);
  return dir;
}

/** Every path, mode and byte under `root`. */
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

const MAKE = "up:\n\t@echo up\ndown:\n\t@echo down\n";

describe("checkOnboardPath", () => {
  it("takes a folder inside home, absolute or with ~/", () => {
    const code = path.join(home, "code");
    fs.mkdirSync(code);
    expect(checkOnboardPath(code, rules())).toEqual({ ok: true, dir: code });
    expect(checkOnboardPath("~/code", rules())).toEqual({
      ok: true,
      dir: code,
    });
  });

  it("needs a path, and an absolute one", () => {
    expect(checkOnboardPath(undefined, rules())).toMatchObject({ ok: false });
    expect(checkOnboardPath("", rules())).toMatchObject({ ok: false });
    const r = checkOnboardPath("code", rules());
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/absolute/);
  });

  it("refuses a folder outside home", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(outside);
    const r = checkOnboardPath(outside, rules());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/outside your home folder/);
    // ../ that climbs out is outside too.
    expect(checkOnboardPath(path.join(home, ".."), rules()).ok).toBe(false);
  });

  it("refuses a symlink in home that points outside it", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, "link"));
    expect(checkOnboardPath(path.join(home, "link"), rules()).ok).toBe(false);
  });

  it("refuses Den's own state folder and anything in it", () => {
    fs.mkdirSync(path.join(state, "logs"));
    for (const p of [state, path.join(state, "logs")]) {
      const r = checkOnboardPath(p, rules());
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/state folder/);
    }
  });

  it("says when there is no folder there", () => {
    const r = checkOnboardPath(path.join(home, "nope"), rules());
    expect(r.ok === false && r.error).toMatch(/no folder/);
  });
});

describe("reposDetect", () => {
  it("finds repos one and two levels deep, says how each runs, and groups them by folder", () => {
    repo("code/acme", { Makefile: MAKE });
    repo("code/north", {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    repo("code/work/notes", {
      "compose.yaml": "services: {}\n",
      "package.json": JSON.stringify({ scripts: { start: "node ." } }),
    });
    const r = reposDetect(path.join(home, "code"), rules());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repos.map((x) => [x.name, x.depth])).toEqual([
      ["acme", 1],
      ["north", 1],
      ["notes", 2],
    ]);
    expect(r.repos[0]).toMatchObject({
      manifest: "none",
      runs: { source: "make", up: "make up", down: "make down" },
      workspace: "code",
    });
    expect(r.repos[1].runs).toMatchObject({ up: "npm run dev" });
    // Two ways to start it: the question, with the choices.
    expect(r.repos[2]).toMatchObject({
      workspace: "work",
      choices: ["docker compose -f compose.yaml up -d", "npm start"],
    });
    expect(r.repos[2].ask).toMatch(/2 ways/);
    expect(r.workspaces).toEqual([
      { name: "code", repos: ["acme", "north"] },
      { name: "work", repos: ["notes"] },
    ]);
    expect(r.truncated).toBe(false);
    expect(r.rule).toMatch(/parent folder/);
  });

  it("skips node_modules, vendor and dot-folders", () => {
    repo("code/node_modules/dep");
    repo("code/vendor/lib");
    repo("code/.cache/thing");
    repo("code/acme", { Makefile: MAKE });
    const r = reposDetect(path.join(home, "code"), rules());
    expect(r.ok && r.repos.map((x) => x.name)).toEqual(["acme"]);
  });

  it("never follows a symlink, in or out of the folder", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(path.join(outside, "secret-repo", ".git"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(home, "code"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "code", "out"));
    fs.symlinkSync(
      path.join(outside, "secret-repo"),
      path.join(home, "code", "direct"),
    );
    repo("code/acme", { Makefile: MAKE });
    fs.symlinkSync(
      path.join(home, "code", "acme"),
      path.join(home, "code", "again"),
    );
    const r = reposDetect(path.join(home, "code"), rules());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repos.map((x) => x.path)).toEqual([
      path.join(home, "code", "acme"),
    ]);
    expect(r.skipped.symlinks).toBe(3);
  });

  it("goes no deeper than two levels", () => {
    repo("code/a/b/deep");
    const r = reposDetect(path.join(home, "code"), rules());
    expect(r.ok && r.repos).toEqual([]);
  });

  it("the folder itself as a repo: just that one, not its subfolders", () => {
    const dir = repo("code/acme", { Makefile: MAKE });
    repo("code/acme/sub");
    const r = reposDetect(dir, rules());
    expect(r.ok && r.repos.map((x) => [x.name, x.depth])).toEqual([
      ["acme", 0],
    ]);
  });

  it("stops at maxRepos and says so", () => {
    for (const n of ["a1", "a2", "a3", "a4"]) repo(`code/${n}`);
    const r = reposDetect(path.join(home, "code"), rules(), { maxRepos: 2 });
    expect(r.ok && r.repos.length).toBe(2);
    expect(r.ok && r.truncated).toBe(true);
  });

  it("a repo's own manifest is named, not detected; a registered repo says where", () => {
    const dir = repo("code/acme", {
      [product().manifestYml]: "version: 1\nname: acme\n",
    });
    const r = reposDetect(path.join(home, "code"), rules(), {
      registered: () => [{ path: dir, workspace: "web", repo: "acme" }],
    });
    expect(r.ok && r.repos[0]).toMatchObject({
      manifest: "repo",
      registered: [{ workspace: "web", repo: "acme" }],
    });
    expect(r.ok && r.repos[0].runs).toBeUndefined();
  });

  it("refuses a path outside home, and writes nothing", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(path.join(outside, "acme", ".git"), { recursive: true });
    const r = reposDetect(outside, rules());
    expect(r.ok).toBe(false);
  });

  it("writes nothing in the folder it scans", () => {
    repo("code/acme", { Makefile: MAKE });
    repo("code/north");
    const before = digest(path.join(home, "code"));
    reposDetect(path.join(home, "code"), rules());
    expect(digest(path.join(home, "code"))).toBe(before);
  });
});

describe("manifestDraft", () => {
  const validate = (m: unknown) => validateManifest(m);

  it("drafts a health URL at the dev server's port, so the service gets a Visit link", () => {
    const vite = repo("code/web", {
      "package.json": JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
    });
    const r = manifestDraft(vite, rules(), validate);
    expect(r.ok).toBe(true);
    expect(r.draft).toMatch(/url: http:\/\/localhost:5173\//);
    const own = repo("code/api", {
      "package.json": JSON.stringify({
        name: "api",
        scripts: { start: "node server.js --port 4410" },
      }),
    });
    expect(manifestDraft(own, rules(), validate).draft).toMatch(
      /url: http:\/\/localhost:4410\//,
    );
    // No port anywhere: no health URL is guessed.
    const plain = repo("code/plain", {
      "package.json": JSON.stringify({
        name: "plain",
        scripts: { dev: "node server.js" },
      }),
    });
    expect(manifestDraft(plain, rules(), validate).draft).not.toMatch(/url:/);
  });

  it("drafts the side-car repo add would write, validated, and writes nothing", () => {
    const dir = repo("code/acme", { Makefile: MAKE, "README.md": "acme\n" });
    const before = digest(dir);
    const r = manifestDraft(dir, rules(), validate, {
      health: "http://localhost:47001/",
    });
    expect(r).toMatchObject({
      ok: true,
      dryRun: true,
      repo: "acme",
      path: dir,
      manifest: { source: "sidecar", written: false, detected: "make" },
      validation: { valid: true, errors: [] },
      services: ["acme"],
    });
    expect(r.draft).toMatch(/up: make up/);
    expect(r.draft).toMatch(/url: http:\/\/localhost:47001\//);
    expect(r.manifest?.file).toBe(
      path.join(manifests, `acme${product().manifestYml}`),
    );
    expect(digest(dir)).toBe(before);
    expect(fs.existsSync(manifests)).toBe(false);
  });

  it("several ways to start it: the question and the choices, nothing drafted", () => {
    const dir = repo("code/notes", {
      "compose.yaml": "services: {}\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    const r = manifestDraft(dir, rules(), validate);
    expect(r.ok).toBe(false);
    expect(r.ask).toMatch(/2 ways/);
    expect(r.choices).toEqual([
      "docker compose -f compose.yaml up -d",
      "npm run dev",
    ]);
    expect(r.draft).toBeUndefined();
    // Naming one drafts it.
    const r2 = manifestDraft(dir, rules(), validate, { run: "npm run dev" });
    expect(r2).toMatchObject({ ok: true, manifest: { detected: "--run" } });
  });

  it("a repo with its own manifest: nothing to draft", () => {
    const dir = repo("code/acme", {
      [product().manifestYml]: "version: 1\nname: acme\n",
    });
    const r = manifestDraft(dir, rules(), validate);
    expect(r).toMatchObject({ ok: true, manifest: { source: "repo" } });
    expect(r.draft).toBeUndefined();
  });

  it("refuses a path outside home", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(outside);
    const r = manifestDraft(outside, rules(), validate);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside your home folder/);
  });
});

describe("mcpRegistration", () => {
  const base = {
    cli: "acme",
    home: "/h",
    platform: "darwin" as NodeJS.Platform,
    projectDir: "/d",
    which: () => false,
    read: (): string | null => null,
  };

  it("asked through Den's MCP: connected", () => {
    expect(mcpRegistration({ ...base, viaMcp: true })).toMatchObject({
      id: "mcp",
      status: "ok",
    });
  });

  it("a client's config file that names the server: connected", () => {
    const r = mcpRegistration({
      ...base,
      read: (f) =>
        f === path.join("/h", ".cursor", "mcp.json")
          ? JSON.stringify({ mcpServers: { acme: { command: "x" } } })
          : null,
    });
    expect(r).toMatchObject({ status: "ok" });
    expect(r.detail).toMatch(/Cursor/);
  });

  it("only a client Den can't check without running it: a warning, not a guess", () => {
    const r = mcpRegistration({ ...base, which: (b) => b === "claude" });
    expect(r.status).toBe("warn");
    expect(r.fix).toBe("acme mcp connect --runtime claude --json");
  });

  it("nothing: a step to do", () => {
    const r = mcpRegistration(base);
    expect(r.status).toBe("todo");
    expect(r.fix).toMatch(/mcp connect --runtime/);
  });
});

describe("onboardStatus", () => {
  const deps = (over: Partial<OnboardStatusDeps> = {}): OnboardStatusDeps => ({
    bin: "./bin/acme",
    distribution: true,
    doctor: {
      nodeVersion: "22.13.0",
      platform: "darwin",
      which: (b) => b === "git",
      dockerRepos: () => [],
      dockerUp: () => false,
      webUrl: "http://localhost:47002",
      probeWeb: async () => ({ kind: "up", version: "0.4.13" }),
      mcpCall: () => {
        throw new Error("onboard status never runs the MCP one-shot");
      },
      bin: "./bin/acme",
    },
    workspaces: () => ({ names: [], active: [], repos: [] }),
    running: () => [],
    mcp: () => ({ id: "mcp", status: "ok", detail: "connected" }),
    ...over,
  });

  it("a fresh Den: checks in order, the next step is a repo", async () => {
    const r = await onboardStatus(deps());
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["distribution", "ok"],
      ["node", "ok"],
      ["git", "ok"],
      ["docker", "ok"],
      ["web", "ok"],
      ["workspaces", "todo"],
      ["repos", "todo"],
      ["service", "todo"],
      ["mcp", "ok"],
    ]);
    expect(r.ok).toBe(false);
    expect(r.next).toMatchObject({
      id: "repos",
      command: "./bin/acme repo detect <folder> --json",
    });
    expect(r.next.step).toMatch(/repo/);
  });

  it("a repo but nothing running: start it", async () => {
    const r = await onboardStatus(
      deps({
        workspaces: () => ({
          names: ["web"],
          active: ["web"],
          repos: ["acme"],
        }),
      }),
    );
    expect(r.next).toMatchObject({
      id: "service",
      command: "./bin/acme up acme --json",
    });
  });

  it("the web server down comes before the repos", async () => {
    const r = await onboardStatus(
      deps({
        doctor: { ...deps().doctor, probeWeb: async () => ({ kind: "down" }) },
      }),
    );
    expect(r.checks.find((c) => c.id === "web")?.status).toBe("todo");
    expect(r.next).toMatchObject({
      id: "web",
      command: "./bin/acme web up --no-open --json",
    });
  });

  it("everything set up: ok, and the next step says so", async () => {
    const r = await onboardStatus(
      deps({
        workspaces: () => ({
          names: ["web"],
          active: ["web"],
          repos: ["acme"],
        }),
        running: () => ["acme/acme"],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.next.id).toBe("done");
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("workspaces but none active: a warning", async () => {
    const r = await onboardStatus(
      deps({
        workspaces: () => ({ names: ["web"], active: [], repos: ["acme"] }),
      }),
    );
    expect(r.checks.find((c) => c.id === "workspaces")?.status).toBe("warn");
  });
});
