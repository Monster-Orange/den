/**
 * Deactivating a workspace releases the daemons it owns, judged by the
 * CURRENT workspaces.yml membership, not the owners recorded when the daemon
 * started. A repo moved out of `default` into `ws-b` while its daemon ran
 * belongs to `ws-b` now: deactivating `default` must not stop it. A repo only
 * `default` contains is still stopped.
 *
 * Real workspaces file and daemon registry in a throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Runner =
  typeof import("../../../src/shared/environment-manager/service-runner.js");
type Workspaces =
  typeof import("../../../src/shared/environment-manager/workspaces.js");
let runner: Runner;
let ws: Workspaces;
let tmp = "";
let wsFile = "";
let repos = "";
const saved = { ...process.env };

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function workspaces(active: string[], members: Record<string, string[]>) {
  write(
    wsFile,
    [
      `active: [${active.join(", ")}]`,
      `focus: ${active[0]}`,
      "workspaces:",
      ...Object.entries(members).flatMap(([name, list]) => [
        `  ${name}:`,
        list.length ? "    services:" : "    services: {}",
        ...list.flatMap((r) => [
          `      ${r}:`,
          "        mode: dev-managed",
          `        path: ${path.join(repos, r)}`,
        ]),
      ]),
      "",
    ].join("\n"),
  );
}

function startedIn(repo: string, owners: string[]): void {
  runner.registerDaemon({
    address: repo,
    repoName: repo,
    subsystem: repo,
    repoPath: path.join(repos, repo),
    branch: null,
    workspaces: owners,
    logPath: path.join(tmp, `${repo}.log`),
    startedAt: new Date(),
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-release-moved-"));
  const root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  wsFile = path.join(root, "config", "local", "workspaces.yml");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["moved", "stays"].map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  for (const r of ["moved", "stays"])
    write(
      path.join(repos, r, ".den.yml"),
      `name: ${r}\nservices:\n  ${r}:\n    commands:\n      local:\n        up: "true"\n        down: "true"\n`,
    );
  process.env.DEN_ROOT = root;
  process.env.DEN_HOME = path.join(tmp, "home");
  process.env.DEN_DAEMONS_FILE = path.join(tmp, "daemons.json");
  delete process.env.DEN_INVOKE_CWD;
  ws = await import("../../../src/shared/environment-manager/workspaces.js");
  runner =
    await import("../../../src/shared/environment-manager/service-runner.js");
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("releaseWorkspaceDaemons after a repo moved workspace", () => {
  it("does not stop a daemon whose repo now lives in another active workspace", async () => {
    // 1. Both daemons start in default.
    workspaces(["default"], {
      default: ["moved", "stays"],
      "ws-b": [],
    });
    startedIn("moved", ["default"]);
    startedIn("stays", ["default"]);

    // 2. `moved` moves into ws-b while its daemon keeps running.
    workspaces(["default"], {
      default: ["stays"],
      "ws-b": ["moved"],
    });
    // 3. Activate ws-b, deactivate default.
    ws.activateWorkspace("ws-b");
    ws.deactivateWorkspace("default");
    const releases = await runner.releaseWorkspaceDaemons("default");

    const byAddress = Object.fromEntries(releases.map((r) => [r.address, r]));
    expect(byAddress.moved).toEqual({
      address: "moved",
      outcome: "detached",
      remaining: ["ws-b"],
    });
    // Its owners are the current ones now.
    const left = runner.listDaemons();
    expect(left.map((d) => [d.address, d.workspaces])).toEqual([
      ["moved", ["ws-b"]],
    ]);
    // The control: a repo only default contains is released.
    expect(byAddress.stays?.outcome).toBe("stopped");
  }, 20_000);
});
