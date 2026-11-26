/**
 * Issue 646 (clause 2, point 4): each project link records the Hub (its
 * origin) and the company it belongs to. A link that points at another Hub,
 * or at another company on this one, counts as not linked: Den sends no id
 * from it, and Connect links the project again on the Hub it is bound to.
 * A link written before this (no Hub recorded) is the bound Hub's: 726
 * archives every link on a change. A real workspaces.yml and state dir
 * (temp DEN_ROOT and DEN_HOME); invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp = "";
let state = "";
const saved = { root: process.env.DEN_ROOT, home: process.env.DEN_HOME };
type Mod = typeof import("../../../src/shared/hub/hub-project-link.js");
let m: Mod;
const file = () => path.join(tmp, "config", "local", "workspaces.yml");
const bind = (v: unknown) => {
  fs.mkdirSync(path.join(state, "hub"), { recursive: true });
  fs.writeFileSync(path.join(state, "hub", "bound.json"), JSON.stringify(v));
};
const ONE = "https://hub-one.example.test";
const TWO = "https://hub-two.example.test";
const LINK = { id: "proj_north1", slug: "north", name: "North" };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubp646-"));
  state = path.join(tmp, "state");
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    file(),
    "active: north\nworkspaces:\n  north:\n    directory: /tmp/north\n  south:\n    directory: /tmp/south\n",
  );
  process.env.DEN_ROOT = tmp;
  process.env.DEN_HOME = state;
  jest.resetModules();
  m = await import("../../../src/shared/hub/hub-project-link.js");
});

afterAll(() => {
  for (const [k, v] of [
    ["DEN_ROOT", saved.root],
    ["DEN_HOME", saved.home],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 646: a link records its Hub and company", () => {
  it("setHubProject stamps the bound Hub's origin and company", () => {
    bind({ url: ONE, origin: ONE, company: "acme", at: "x" });
    m.setHubProject("north", LINK);
    expect(m.hubProjectOf("north")).toEqual({
      ...LINK,
      hub: { origin: ONE, company: "acme" },
    });
    expect(fs.readFileSync(file(), "utf8")).toContain(ONE);
  });

  it("a link to another Hub counts as not linked, and says where it points", () => {
    bind({ url: TWO, origin: TWO, company: "acme", at: "x" });
    expect(m.hubProjectOf("north")).toBeNull();
    expect(m.hubLinkElsewhere("north")).toEqual({
      ...LINK,
      hub: { origin: ONE, company: "acme" },
    });
  });

  it("another company on the same Hub is another Hub too", () => {
    bind({ url: ONE, origin: ONE, company: "globex", at: "x" });
    expect(m.hubProjectOf("north")).toBeNull();
    expect(m.hubLinkElsewhere("north")?.hub?.company).toBe("acme");
  });

  it("the same Hub and company: linked, and nothing elsewhere", () => {
    bind({ url: ONE, origin: ONE, company: "acme", at: "x" });
    expect(m.hubProjectOf("north")?.id).toBe(LINK.id);
    expect(m.hubLinkElsewhere("north")).toBeNull();
  });

  it("hubElsewhereMap: the projects whose link points at another Hub (for the page)", () => {
    bind({ url: TWO, origin: TWO, company: "acme", at: "x" });
    expect(m.hubElsewhereMap(["north", "south", "nope"])).toEqual({
      north: true,
    });
    bind({ url: ONE, origin: ONE, company: "acme", at: "x" });
    expect(m.hubElsewhereMap(["north", "south"])).toEqual({});
  });

  it("a link from before (no Hub recorded) is the bound Hub's", () => {
    bind({ url: TWO, origin: TWO, at: "x" });
    // Written by hand, as an older Den wrote it.
    const text = fs
      .readFileSync(file(), "utf8")
      .replace(
        /south:\n(\s+)directory: \/tmp\/south\n/,
        "south:\n$1directory: /tmp/south\n$1hub_project:\n$1  id: proj_south1\n$1  slug: south\n$1  name: South\n",
      );
    fs.writeFileSync(file(), text);
    expect(m.hubProjectOf("south")?.id).toBe("proj_south1");
    expect(m.hubLinkElsewhere("south")).toBeNull();
  });

  it("relinking on the new Hub replaces the old Hub's id and stamp", () => {
    bind({ url: TWO, origin: TWO, company: "acme", at: "x" });
    m.setHubProject("north", { id: "proj_north2", slug: "n", name: "N" });
    expect(m.hubProjectOf("north")).toEqual({
      id: "proj_north2",
      slug: "n",
      name: "N",
      hub: { origin: TWO, company: "acme" },
    });
    expect(fs.readFileSync(file(), "utf8")).not.toContain("proj_north1");
  });

  it("isLinkElsewhere: a pure check of a link against a binding", () => {
    const b = { url: ONE, origin: ONE, company: "acme", at: "" };
    expect(m.isLinkElsewhere(LINK, b)).toBe(false);
    expect(m.isLinkElsewhere({ ...LINK, hub: { origin: ONE } }, b)).toBe(false);
    expect(m.isLinkElsewhere({ ...LINK, hub: { origin: TWO } }, b)).toBe(true);
    expect(
      m.isLinkElsewhere({ ...LINK, hub: { origin: ONE, company: "x" } }, b),
    ).toBe(true);
    expect(m.isLinkElsewhere({ ...LINK, hub: { origin: TWO } }, null)).toBe(
      false,
    );
  });
});
