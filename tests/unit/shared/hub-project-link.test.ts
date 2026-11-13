/**
 * H5: a project's Hub project, written to and read from a real
 * config/local/workspaces.yml (a temp DEN_ROOT), next to its other keys.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp = "";
const before = process.env.DEN_ROOT;
type Mod = typeof import("../../../src/shared/hub-project-link.js");
let m: Mod;
const file = () => path.join(tmp, "config", "local", "workspaces.yml");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubp-"));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    file(),
    "active: north\nworkspaces:\n  north:\n    directory: /tmp/north\n    editor: vim\n",
  );
  process.env.DEN_ROOT = tmp;
  jest.resetModules();
  m = await import("../../../src/shared/hub-project-link.js");
});

afterAll(() => {
  if (before === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = before;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("setHubProject / hubProjectOf (a real file)", () => {
  it("links, keeps the project's other keys, and reads it back", () => {
    expect(m.hubProjectOf("north")).toBeNull();
    m.setHubProject("north", {
      id: "proj_back1",
      slug: "back-office",
      name: "Back office",
    });
    expect(m.hubProjectOf("north")).toEqual({
      id: "proj_back1",
      slug: "back-office",
      name: "Back office",
    });
    const text = fs.readFileSync(file(), "utf-8");
    expect(text).toContain("hub_project:");
    expect(text).toContain("editor: vim");
  });

  it("unlinks: the key is gone", () => {
    m.setHubProject("north", null);
    expect(m.hubProjectOf("north")).toBeNull();
    expect(fs.readFileSync(file(), "utf-8")).not.toContain("hub_project");
  });

  it("refuses a project that isn't there, and an id that isn't Hub's", () => {
    expect(() => m.setHubProject("south", null)).toThrow(
      'project "south" does not exist',
    );
    expect(() =>
      m.setHubProject("north", { id: "../x", slug: "x", name: "x" }),
    ).toThrow("is not a Hub project id");
  });

  it("a hand-edited bad value reads as not linked", () => {
    fs.writeFileSync(
      file(),
      "workspaces:\n  north:\n    directory: /tmp/north\n    hub_project: { id: nope }\n",
    );
    expect(m.hubProjectOf("north")).toBeNull();
  });
});
