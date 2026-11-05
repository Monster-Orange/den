/**
 * Workspace seeding from the distribution's blueprint happens only on a
 * genuine fresh setup (nothing but an empty, never-seeded `default`), and
 * never silently: without a TTY a command prints a hint and changes nothing;
 * `<cli> workspace seed` seeds. Top-up never runs next to other workspaces,
 * and a repo removed from `default` is never re-added. `defaults.workspaces`
 * seeds several named workspaces; both blueprint shapes at once is an error.
 *
 * Real bin/den (spawned without a TTY) in a throwaway distribution, and the
 * real web server for the DELETE route.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { startSlowGitServer } from "../server/helpers/slow-git-server.js";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-ws-seeding-"));
let tmp = "";
let root = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** A docker that reports nothing running. */
function dockerShim(): string {
  const dir = path.join(tmp, "shim");
  write(path.join(dir, "docker"), "#!/bin/sh\nexit 0\n", 0o755);
  return dir;
}

function den(args: string[]): { out: string; status: number | null } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"], // no TTY
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      PATH: `${dockerShim()}:${process.env.PATH ?? ""}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const wsPath = () => path.join(root, "config", "local", "workspaces.yml");

/** The org config: `defaults` given as YAML lines (already indented). */
function config(defaults: string[]): void {
  write(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "github_org: acme", "defaults:", ...defaults, ""]
      .filter((l) => l !== "defaults:" || defaults.length > 0)
      .join("\n"),
  );
}

const SINGLE = [
  "  workspace:",
  "    branch: main",
  "    repos: [alpha, beta, gamma]",
];

function workspaces(doc: unknown): void {
  write(wsPath(), yaml.stringify(doc));
}

function readWs(): {
  active: string[];
  focus?: string;
  workspaces: Record<
    string,
    { services: Record<string, unknown>; seeded_repos?: string[] }
  >;
} {
  return yaml.parse(fs.readFileSync(wsPath(), "utf-8"));
}

const managed = { mode: "managed", branch: "main" };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(tmpBase, "case-"));
  root = path.join(tmp, "den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "local", "service-catalog.yml"), "{}\n");
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("auto-seeding only on a genuine fresh setup", () => {
  it("an emptied default with seeded_repos is not re-seeded, and not prompted", () => {
    config(SINGLE);
    workspaces({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: { services: {}, seeded_repos: ["alpha", "beta", "gamma"] },
      },
    });
    const before = fs.readFileSync(wsPath(), "utf-8");
    const { out } = den(["status"]);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
    expect(out).not.toMatch(/Seed the default workspace|workspace seed/);
  }, 60_000);

  it("with other workspaces: no seed and no top-up", () => {
    config(SINGLE);
    // The repos moved out of default into per-project workspaces, default
    // deactivated — and one blueprint repo (gamma) is new since seeding.
    workspaces({
      active: ["proj-a", "proj-b"],
      focus: "proj-a",
      workspaces: {
        default: { services: {}, seeded_repos: ["alpha", "beta"] },
        "proj-a": { services: { alpha: managed } },
        "proj-b": { services: { beta: managed } },
      },
    });
    const before = fs.readFileSync(wsPath(), "utf-8");
    den(["status"]);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);

    // Same with default still holding a repo: top-up must not add gamma.
    workspaces({
      active: ["default", "proj-a"],
      focus: "default",
      workspaces: {
        default: { services: { beta: managed } },
        "proj-a": { services: { alpha: managed } },
      },
    });
    const before2 = fs.readFileSync(wsPath(), "utf-8");
    den(["status"]);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before2);
  }, 60_000);

  it("without a TTY, a fresh setup prints the hint and changes nothing", () => {
    config(SINGLE);
    const { out } = den(["status"]);
    expect(out).toMatch(
      /default workspace is empty: run `den workspace seed` to fill it from the blueprint/,
    );
    expect(out).not.toMatch(/Default workspace ready/);
    // Nothing seeded: no workspaces.yml with services was written.
    const ws = fs.existsSync(wsPath()) ? readWs() : null;
    expect(Object.keys(ws?.workspaces.default?.services ?? {})).toEqual([]);
    expect(ws?.workspaces.default?.seeded_repos).toBeUndefined();
  }, 60_000);
});

describe("a repo removed from default is never re-added", () => {
  it("DELETE from a default that predates seeded_repos sticks", async () => {
    config(SINGLE);
    // From before seeded_repos: top-up's one-time migration would treat the
    // whole blueprint as new and bring beta back.
    workspaces({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: { services: { alpha: managed, beta: managed } },
      },
    });
    const srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ workspace: "default", address: "beta" });
        const req = http.request(
          {
            host: "127.0.0.1",
            port: srv.port,
            path: "/api/workspaces/services",
            method: "DELETE",
            agent: false,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      expect(status).toBe(200);
    } finally {
      await srv.stop();
    }
    expect(Object.keys(readWs().workspaces.default.services)).toEqual([
      "alpha",
    ]);

    den(["status"]);
    den(["status"]);
    const def = readWs().workspaces.default;
    // gamma is genuinely new to this workspace; beta was removed on purpose.
    expect(Object.keys(def.services).sort()).toEqual(["alpha", "gamma"]);
  }, 90_000);
});

describe("explicit seeding", () => {
  it("fresh setup, single blueprint: `workspace seed` seeds default as before", () => {
    config(SINGLE);
    const { out, status } = den(["workspace", "seed"]);
    expect(status).toBe(0);
    expect(out).toMatch(/Default workspace ready — 3 repos/);
    const ws = readWs();
    expect(ws.active).toEqual(["default"]);
    expect(ws.focus).toBe("default");
    expect(ws.workspaces.default.services).toEqual({
      alpha: managed,
      beta: managed,
      gamma: managed,
    });
    expect(ws.workspaces.default.seeded_repos).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  }, 60_000);

  it("fresh setup, single blueprint: `init` in the root still seeds", () => {
    config(SINGLE);
    const { status } = den(["init", root]);
    expect(status).toBe(0);
    expect(Object.keys(readWs().workspaces.default.services)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  }, 60_000);

  it("fresh setup, multi blueprint: creates each workspace, all active, focus as marked", () => {
    config([
      "  workspaces:",
      "    web:",
      "      repos: [alpha, beta]",
      "    data:",
      "      repos: [gamma]",
      "      branch: develop",
      "      focus: true",
      "    tools:",
      "      repos: [delta]",
      "      autostart_off: [delta]",
    ]);
    const hint = den(["status"]);
    expect(hint.out).toMatch(
      /no workspaces yet: run `den workspace seed` to create them from the blueprint/,
    );

    const { out, status } = den(["workspace", "seed"]);
    expect(status).toBe(0);
    expect(out).toMatch(/3 workspaces ready \(web, data, tools\)/);
    const ws = readWs();
    expect(ws.active).toEqual(["web", "data", "tools"]);
    expect(ws.focus).toBe("data");
    expect(ws.workspaces.web.services).toEqual({
      alpha: managed,
      beta: managed,
    });
    expect(ws.workspaces.data.services).toEqual({
      gamma: { mode: "managed", branch: "develop" },
    });
    expect(ws.workspaces.tools.services).toEqual({
      delta: { mode: "managed", branch: "main", autostart: false },
    });
    expect(ws.workspaces.web.seeded_repos).toEqual(["alpha", "beta"]);

    // Seeded: later commands neither hint nor touch anything.
    const before = fs.readFileSync(wsPath(), "utf-8");
    expect(den(["status"]).out).not.toMatch(/workspace seed/);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
  }, 60_000);

  it("multi blueprint without a focus mark focuses the first", () => {
    config([
      "  workspaces:",
      "    web:",
      "      repos: [alpha]",
      "    data:",
      "      repos: [gamma]",
    ]);
    expect(den(["workspace", "seed"]).status).toBe(0);
    const ws = readWs();
    expect(ws.active).toEqual(["web", "data"]);
    expect(ws.focus).toBe("web");
  }, 60_000);

  it("both blueprint shapes at once is a clear error", () => {
    config([...SINGLE, "  workspaces:", "    web:", "      repos: [alpha]"]);
    const { out, status } = den(["workspace", "seed"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(
      /sets both defaults\.workspace and defaults\.workspaces/,
    );
    expect(fs.existsSync(wsPath()) ? readWs().workspaces.web : undefined).toBe(
      undefined,
    );
  }, 60_000);
});

describe("a repeat seed", () => {
  it("single blueprint: says 'already seeded' and changes nothing", () => {
    config(SINGLE);
    expect(den(["workspace", "seed"]).status).toBe(0);
    const before = fs.readFileSync(wsPath(), "utf-8");
    const { out, status } = den(["workspace", "seed"]);
    expect(status).toBe(0);
    expect(out).toMatch(
      /Default workspace already seeded — 3 repos \(managed\): nothing changed/,
    );
    expect(out).not.toMatch(/Default workspace ready/);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
  }, 60_000);

  it("multi blueprint: names the workspaces already seeded", () => {
    config([
      "  workspaces:",
      "    web:",
      "      repos: [alpha, beta]",
      "    data:",
      "      repos: [gamma]",
    ]);
    expect(den(["workspace", "seed"]).status).toBe(0);
    const before = fs.readFileSync(wsPath(), "utf-8");
    const { out } = den(["workspace", "seed"]);
    expect(out).toMatch(
      /2 workspaces already seeded \(web, data\): nothing changed/,
    );
    expect(out).not.toMatch(/workspaces ready/);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
  }, 60_000);

  it("after the user changed the workspace, a seed says it reset it", () => {
    config(SINGLE);
    den(["workspace", "seed"]);
    const ws = readWs();
    ws.workspaces.default.services.beta = { mode: "dev-managed" };
    workspaces(ws);
    const { out } = den(["workspace", "seed"]);
    expect(out).toMatch(/Default workspace reset to the blueprint — 3 repos/);
    expect(out).not.toMatch(/already seeded/);
    expect(readWs().workspaces.default.services.beta).toEqual(managed);
  }, 60_000);

  it("one repo reads '1 repo', never '1 repos'", () => {
    config(["  workspace:", "    branch: main", "    repos: [alpha]"]);
    const first = den(["workspace", "seed"]);
    expect(first.out).toMatch(/Default workspace — 1 repo, all managed/);
    expect(first.out).toMatch(/Default workspace ready — 1 repo \(managed\)/);
    const again = den(["workspace", "seed"]);
    expect(again.out).toMatch(/already seeded — 1 repo \(managed\)/);
    expect(`${first.out}${again.out}`).not.toMatch(/\b1 repos\b/);
  }, 60_000);
});
