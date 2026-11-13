/**
 * Every writer of config/local/workspaces.yml keeps a workspace's existing
 * keys, hub_project above all. Real fs in a temp DEN_ROOT, nothing mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

let tmp: string;
let wsPath: string;
let ws: typeof import("../../../src/shared/environment-manager/workspaces.js");
let hub: typeof import("../../../src/shared/hub-project-link.js");

const A = { id: "proj_abc", slug: "abc", name: "Abc" };
const B = { id: "proj_def", slug: "def", name: "Def" };

function seed(extra: Record<string, unknown> = {}, active = ["alpha", "beta"]) {
  fs.writeFileSync(
    wsPath,
    yaml.stringify({
      active,
      focus: "alpha",
      workspaces: {
        alpha: { services: {}, hub_project: A, editor: "code" },
        beta: { services: {}, hub_project: B, editor: "vim" },
        ...extra,
      },
    }),
  );
}
const disk = () =>
  yaml.parse(fs.readFileSync(wsPath, "utf-8")) as {
    workspaces: Record<string, Record<string, unknown>>;
  };
function expectLinks(a = "alpha", b = "beta") {
  const w = disk().workspaces;
  expect(w[a]?.hub_project).toEqual(A);
  expect(w[b]?.hub_project).toEqual(B);
  expect(w[a]?.editor).toBe("code");
  expect(w[b]?.editor).toBe("vim");
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-ws-keep-"));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  process.env.DEN_ROOT = tmp;
  wsPath = path.join(tmp, "config/local/workspaces.yml");
  ws = await import("../../../src/shared/environment-manager/workspaces.js");
  hub = await import("../../../src/shared/hub-project-link.js");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => seed());

describe("workspaces.yml writers keep hub_project", () => {
  it("setFocusedWorkspace", () => {
    ws.setFocusedWorkspace("beta");
    expect(disk()).toMatchObject({ workspaces: expect.anything() });
    expectLinks();
  });
  it("activateWorkspace / deactivateWorkspace", () => {
    seed({}, ["alpha"]);
    ws.activateWorkspace("beta");
    expectLinks();
    ws.deactivateWorkspace("alpha");
    expectLinks();
  });
  it("setActiveWorkspace", () => {
    ws.setActiveWorkspace("beta");
    expectLinks();
  });
  it("createWorkspace (a third one)", () => {
    ws.createWorkspace("gamma", { services: {} });
    expectLinks();
  });
  it("renameWorkspace", () => {
    ws.renameWorkspace("alpha", "Alpha Team");
    expectLinks();
  });
  it("setWorkspaceRuntimeBin set and clear", () => {
    ws.setWorkspaceRuntimeBin("alpha", "claude", "/usr/bin/claude");
    expectLinks();
    ws.setWorkspaceRuntimeBin("alpha", "claude", null);
    expectLinks();
  });
  it("setWorkspaceAgentPermission set and clear", () => {
    ws.setWorkspaceAgentPermission("beta", "plan");
    expectLinks();
    ws.setWorkspaceAgentPermission("beta", null);
    expectLinks();
  });
  it("setHubProject on the other one", () => {
    hub.setHubProject("beta", B);
    expectLinks();
    hub.setHubProject("alpha", A);
    expectLinks();
  });
  it("deleteWorkspaceConfig of a third", () => {
    seed({ gamma: { services: {} } });
    ws.deleteWorkspaceConfig("gamma");
    expectLinks();
  });
  it("plain read then write round trip", () => {
    ws.writeWorkspacesFile(ws.readWorkspacesFile());
    expectLinks();
  });
  it("read alone keeps them (and a legacy string active migrates)", () => {
    fs.writeFileSync(
      wsPath,
      yaml.stringify({
        active: "alpha",
        workspaces: {
          alpha: { services: {}, hub_project: A, editor: "code" },
          beta: { services: {}, hub_project: B, editor: "vim" },
        },
      }),
    );
    ws.readWorkspacesFile();
    expectLinks();
  });
  it("slug migration carries hub_project to the new key", () => {
    fs.writeFileSync(
      wsPath,
      yaml.stringify({
        active: ["back office", "beta"],
        focus: "back office",
        workspaces: {
          "back office": { services: {}, hub_project: A, editor: "code" },
          beta: { services: {}, hub_project: B, editor: "vim" },
        },
      }),
    );
    ws.readWorkspacesFile();
    const w = disk().workspaces;
    expect(w["back office"]).toBeUndefined();
    expect(w["back-office"]?.hub_project).toEqual(A);
    expect(w["back-office"]?.name).toBe("back office");
    expect(w.beta?.hub_project).toEqual(B);
  });
  it("a missing file read gives the default, which a writer persists (documents the ENOENT path)", () => {
    fs.rmSync(wsPath);
    ws.setFocusedWorkspace("default");
    expect(Object.keys(disk().workspaces)).toEqual(["default"]);
  });
});
