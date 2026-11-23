/**
 * Issue 1215: on a test install, the fixture person (a live check) may
 * create a project, and activate, deactivate and delete the projects it
 * made, through the existing routes. Nothing else in the project family,
 * no project it didn't make, no clean-up of clones, and never on an
 * install that isn't a test install or with an agent's claim on the
 * session. Its own projects are listed in the state folder.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixtureProjectRefusal,
  fixtureProjects,
  forgetFixtureProject,
  rememberFixtureProject,
  type FixtureProjectAsk,
} from "../../../src/ui/server/fixture-projects.js";

const ok: FixtureProjectAsk = {
  testInstall: true,
  claimed: false,
  op: "activate",
  slug: "fx-long",
  mine: ["fx-long"],
};
const ask = (o: Partial<FixtureProjectAsk>) =>
  fixtureProjectRefusal({ ...ok, ...o });

describe("what the fixture person may do with projects (issue 1215)", () => {
  it.each(["create", "activate", "deactivate", "delete"] as const)(
    "%s its own project: allowed",
    (op) => {
      expect(
        ask({ op, slug: op === "create" ? "fx-new" : "fx-long" }),
      ).toBeNull();
    },
  );

  it("refused on an install that isn't a test install", () => {
    for (const op of ["create", "activate", "deactivate", "delete"] as const)
      expect(ask({ op, testInstall: false })?.code).toBe("not_test_install");
  });

  it("refused with an agent's claim on the fixture session", () => {
    expect(ask({ op: "create", claimed: true })?.code).toBe("fixture_scope");
  });

  it.each(["activate", "deactivate", "delete"] as const)(
    "%s a project it didn't make: refused",
    (op) => {
      expect(ask({ op, slug: "people-project" })?.code).toBe(
        "fixture_not_its_project",
      );
    },
  );

  it.each(["focus", "use", "rename"] as const)("%s: refused", (op) => {
    expect(ask({ op })?.code).toBe("fixture_scope");
  });

  it.each(["cleanupDirectory", "cleanupDev", "cleanupDen"] as const)(
    "delete with %s: refused (no clones removed)",
    (flag) => {
      expect(ask({ op: "delete", flags: { [flag]: true } })?.code).toBe(
        "fixture_scope",
      );
    },
  );

  it("delete that moves agents: refused; stop is allowed", () => {
    expect(ask({ op: "delete", agents: "move" })?.code).toBe("fixture_scope");
    expect(ask({ op: "delete", agents: "stop" })).toBeNull();
  });

  it("every refusal is a 403 that says what to do", () => {
    const r = ask({ op: "delete", slug: "people-project" });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/fixture person/);
  });
});

describe("the fixture person's own projects, in the state folder", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-fx1215-"));
    dirs.push(d);
    return d;
  };

  it("none until it makes one; remembered and forgotten by slug", () => {
    const d = dir();
    expect(fixtureProjects(d)).toEqual([]);
    rememberFixtureProject(d, "fx-a");
    rememberFixtureProject(d, "fx-b");
    rememberFixtureProject(d, "fx-a");
    expect(fixtureProjects(d)).toEqual(["fx-a", "fx-b"]);
    forgetFixtureProject(d, "fx-a");
    expect(fixtureProjects(d)).toEqual(["fx-b"]);
  });

  it("an unreadable or hand-edited file means none (never a project it didn't make)", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "fixture-projects.json"), "{not json");
    expect(fixtureProjects(d)).toEqual([]);
    fs.writeFileSync(
      path.join(d, "fixture-projects.json"),
      JSON.stringify({ projects: ["ok-one", 7, "../x", ""] }),
    );
    expect(fixtureProjects(d)).toEqual(["ok-one"]);
  });
});
