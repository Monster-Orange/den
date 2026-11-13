/**
 * 0.4.36: a project created before D70 under the name as typed ("den hub",
 * by the web's New project, which allowed spaces) was a project every page
 * refused (`"den hub" is not a workspace name`). Reading the file moves it
 * to its slug, the typed name kept for people; its folder, found by the
 * old key, stays its folder; active and focus follow; the file is saved.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp = "";
let root = "";
const before = process.env.DEN_ROOT;
type Mod =
  typeof import("../../../src/shared/environment-manager/workspaces.js");
let m: Mod;
const file = () => path.join(root, "config", "local", "workspaces.yml");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-wskey-"));
  root = path.join(tmp, "den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    file(),
    [
      "active: [web, den hub]",
      "focus: den hub",
      "workspaces:",
      "  web: { services: {} }",
      "  den-hub: { services: {} }",
      "  den hub:",
      "    services:",
      "      hub: { mode: dev-managed }",
      "",
    ].join("\n"),
  );
  process.env.DEN_ROOT = root;
  jest.resetModules();
  m = await import("../../../src/shared/environment-manager/workspaces.js");
  fs.mkdirSync(path.join(m.DEN_WORKSPACES_DIR, "den hub"), { recursive: true });
});

afterAll(() => {
  if (before === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = before;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a project key with a space, from before D70", () => {
  it("moves to the next free slug, keeps its name and folder, and is saved", () => {
    const f = m.readWorkspacesFile();
    expect(Object.keys(f.workspaces).sort()).toEqual([
      "den-hub",
      "den-hub-2",
      "web",
    ]);
    expect(f.workspaces["den-hub-2"]).toEqual({
      name: "den hub",
      directory: path.join(m.DEN_WORKSPACES_DIR, "den hub"),
      services: { hub: { mode: "dev-managed" } },
    });
    expect(f.active).toEqual(["web", "den-hub-2"]);
    expect(f.focus).toBe("den-hub-2");
    const saved = fs.readFileSync(file(), "utf-8");
    expect(saved).toContain("den-hub-2:");
    expect(saved).not.toMatch(/^ {2}den hub:/m);
  });

  it("the name people typed still finds it", () => {
    expect(m.resolveWorkspaceInput("den hub")).toBe("den-hub-2");
  });
});

describe("a project written by hand without services", () => {
  it("reads as one with none (workspace list crashed)", () => {
    const yml = fs.readFileSync(file(), "utf-8");
    fs.writeFileSync(file(), yml + "  bare: { name: Bare }\n  empty:\n");
    const f = m.readWorkspacesFile();
    expect(f.workspaces.bare?.services).toEqual({});
    expect(f.workspaces.empty?.services).toEqual({});
  });
});
