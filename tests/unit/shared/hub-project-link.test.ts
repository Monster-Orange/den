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
type Mod = typeof import("../../../src/shared/hub/hub-project-link.js");
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
  m = await import("../../../src/shared/hub/hub-project-link.js");
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

  it("0.4.45: unlink keeps Hub's last name as the project's name", () => {
    // The screen doesn't change: the name shown was Hub's, and stays.
    m.setHubProject("north", {
      id: "proj_back1",
      slug: "back-office",
      name: "North Star",
    });
    m.setHubProject("north", null);
    expect(fs.readFileSync(file(), "utf-8")).toMatch(/name: North Star/);
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

describe("a Hub project id (H5)", () => {
  it("takes proj_… and a uuid (Hub's Postgres ids), nothing else", () => {
    expect(
      m.parseHubProjectLink({ id: "proj_back1", slug: "b", name: "B" })?.id,
    ).toBe("proj_back1");
    expect(
      m.parseHubProjectLink({
        id: "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f",
        slug: "b",
        name: "B",
      })?.id,
    ).toBe("3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f");
    for (const id of ["../x", "proj_", "3f2a9c1e-7b4d", "proj_A B"])
      expect(m.parseHubProjectLink({ id, slug: "b", name: "B" })).toBeNull();
  });
});

/**
 * Issue 167 (mock v6 A3): a rename asked of Hub waits next to the link,
 * `<ws>.hub_rename: {to, held, url, askedAt}`, until a sync brings that
 * name. Unlinking, or linking another Hub project, drops it.
 */
describe("a rename waiting in Hub (a real file)", () => {
  const STAR = { id: "proj_star1", slug: "north-star", name: "North Star" };
  const ASK = {
    to: "Polaris",
    held: "held_1",
    url: "https://hub.example.test/acme/held/held_1",
    askedAt: "2026-11-15T10:00:00.000Z",
  };

  it("is kept next to the link and read back", () => {
    m.setHubProject("north", STAR);
    expect(m.hubRenameOf("north")).toBeNull();
    m.setHubRename("north", ASK);
    expect(m.hubRenameOf("north")).toEqual(ASK);
    expect(m.hubProjectOf("north")).toEqual(STAR);
    m.setHubRename("north", null);
    expect(m.hubRenameOf("north")).toBeNull();
  });

  it("a bad value reads as none; a link that isn't http(s) is dropped", () => {
    expect(m.parseHubRename({ to: "", held: "h" })).toBeNull();
    expect(m.parseHubRename({ to: "X", held: "" })).toBeNull();
    expect(m.parseHubRename({ ...ASK, url: "javascript:alert(1)" })).toEqual({
      to: "Polaris",
      held: "held_1",
      askedAt: ASK.askedAt,
    });
  });

  it("unlinking, or linking another Hub project, drops it; the same link keeps it", () => {
    m.setHubProject("north", STAR);
    m.setHubRename("north", ASK);
    m.setHubProject("north", { ...STAR, name: "North Star 2" });
    expect(m.hubRenameOf("north")).toEqual(ASK);
    m.setHubProject("north", { id: "proj_other1", slug: "o", name: "O" });
    expect(m.hubRenameOf("north")).toBeNull();
    m.setHubProject("north", STAR);
    m.setHubRename("north", ASK);
    m.setHubProject("north", null);
    expect(m.hubRenameOf("north")).toBeNull();
  });
});
