/**
 * Issue 1215: a project is the test install fixture person's own only when
 * its record carries `fixture_made: true`, which only the server's fixture
 * create writes (createWorkspace's fixtureMade option). A config passed in
 * never carries it through, and a blueprint seed over an existing record
 * strips it. Real fs in a temp DEN_ROOT, nothing mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

let tmp: string;
let wsPath: string;
let ws: typeof import("../../../src/shared/environment-manager/workspaces.js");
let seed: typeof import("../../../src/shared/environment-manager/default-workspace.js");

const disk = () =>
  yaml.parse(fs.readFileSync(wsPath, "utf-8")) as {
    workspaces: Record<string, Record<string, unknown>>;
  };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-fx1215-marker-"));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(tmp, "config", "den.yml"),
    [
      "github_org: acme",
      "defaults:",
      "  workspaces:",
      "    demo:",
      "      repos: [acme-api]",
      "      focus: true",
      "",
    ].join("\n"),
  );
  wsPath = path.join(tmp, "config", "local", "workspaces.yml");
  process.env.DEN_ROOT = tmp;
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  ws = await import("../../../src/shared/environment-manager/workspaces.js");
  seed =
    await import("../../../src/shared/environment-manager/default-workspace.js");
});

afterAll(() => {
  delete process.env.DEN_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the fixture person's marker on a project (issue 1215)", () => {
  it("createWorkspace writes it only when asked", () => {
    ws.createWorkspace("fx made", { services: {} }, { fixtureMade: true });
    ws.createWorkspace("plain one", { services: {} });
    expect(disk().workspaces["fx-made"]?.fixture_made).toBe(true);
    expect(disk().workspaces["plain-one"]).not.toHaveProperty("fixture_made");
  });

  it("never copies it from a config passed in", () => {
    ws.createWorkspace("copied", {
      services: {},
      fixture_made: true,
    });
    expect(disk().workspaces.copied).not.toHaveProperty("fixture_made");
  });

  it("a blueprint seed over a record that had it strips it", () => {
    const d = disk();
    d.workspaces.demo = { services: {}, fixture_made: true, editor: "code" };
    fs.writeFileSync(wsPath, yaml.stringify(d));
    seed.seedBlueprintWorkspaces();
    const demo = disk().workspaces.demo;
    expect(demo).not.toHaveProperty("fixture_made");
    // Its other keys stay, as a seed keeps them.
    expect(demo.editor).toBe("code");
  });
});
