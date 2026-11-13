/**
 * 0.4.44: every change to workspaces.yml is an audit row naming its
 * writer, and every Hub link change is its own row (project, old → new,
 * who). Doctor's lost-link check reads what was seen. Real fs in a temp
 * DEN_ROOT and DEN_HOME, nothing mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

let tmp: string;
let state: string;
let wsPath: string;
let ws: typeof import("../../../src/shared/environment-manager/workspaces.js");
let hub: typeof import("../../../src/shared/hub-project-link.js");
let seen: typeof import("../../../src/shared/hub-links-seen.js");
let audit: typeof import("../../../src/shared/config-audit.js");

const A = { id: "proj_abc", slug: "abc", name: "Abc" };
const B = { id: "proj_def", slug: "def", name: "Def" };

type Row = { verb: string; detail: string; principal?: string; actor: string };
const rows = (): Row[] => {
  const f = path.join(state, "audit.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
};

function seed() {
  fs.writeFileSync(
    wsPath,
    yaml.stringify({
      active: ["alpha", "beta"],
      focus: "alpha",
      workspaces: {
        alpha: { services: {}, editor: "code" },
        beta: { services: {}, hub_project: B },
      },
    }),
  );
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-cfg-audit-"));
  state = path.join(tmp, "state");
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  process.env.DEN_ROOT = tmp;
  process.env.DEN_HOME = state;
  wsPath = path.join(tmp, "config/local/workspaces.yml");
  ws = await import("../../../src/shared/environment-manager/workspaces.js");
  hub = await import("../../../src/shared/hub-project-link.js");
  seen = await import("../../../src/shared/hub-links-seen.js");
  audit = await import("../../../src/shared/config-audit.js");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  audit.setConfigAuditSink(null);
  seed();
});

describe("Hub link rows", () => {
  it("a link says the project, none → new, and who", () => {
    hub.setHubProject("alpha", A, "Settings (person:me)");
    const link = rows().filter((r) => r.verb === "hub-link");
    expect(link).toHaveLength(1);
    expect(link[0].detail).toBe(
      "project alpha: Hub project none → abc (proj_abc), by Settings (person:me)",
    );
  });

  it("an unlink says old → none", () => {
    hub.setHubProject("beta", null, "cli hub link --none");
    const link = rows().filter((r) => r.verb === "hub-link");
    expect(link.map((r) => r.detail)).toEqual([
      "project beta: Hub project def (proj_def) → none, by cli hub link --none",
    ]);
  });

  it("a replaced link says old → new", () => {
    hub.setHubProject("beta", A, "Link suggestions (person:me)");
    expect(rows().filter((r) => r.verb === "hub-link")[0].detail).toBe(
      "project beta: Hub project def (proj_def) → abc (proj_abc), by Link suggestions (person:me)",
    );
  });

  it("any other writer that drops a link is a row too, naming it", () => {
    const f = ws.readWorkspacesFile();
    delete (f.workspaces.beta as { hub_project?: unknown }).hub_project;
    ws.writeWorkspacesFile(f);
    const link = rows().filter((r) => r.verb === "hub-link");
    expect(link).toHaveLength(1);
    expect(link[0].detail).toMatch(
      /^project beta: Hub project def \(proj_def\) → none, by .+config-audit\.test/,
    );
  });

  it("the same link written again is no row", () => {
    hub.setHubProject("beta", B, "Settings");
    expect(rows().filter((r) => r.verb === "hub-link")).toHaveLength(0);
  });
});

describe("workspaces.yml rows", () => {
  it("a write that changes something names the writer and what", () => {
    ws.setFocusedWorkspace("beta");
    const w = rows().filter((r) => r.verb === "config-write");
    expect(w).toHaveLength(1);
    expect(w[0].detail).toMatch(/^workspaces\.yml by setFocusedWorkspace \(/);
    expect(w[0].detail).toContain("focus alpha → beta");
    expect(w[0].actor).toBe("user");
    expect(w[0].principal).toMatch(/^person:/);
  });

  it("a write that changes nothing leaves no row", () => {
    ws.writeWorkspacesFile(ws.readWorkspacesFile());
    expect(rows()).toHaveLength(0);
  });

  it("the server's sink gets the rows instead of the file", () => {
    const got: { verb: string; detail: string }[] = [];
    audit.setConfigAuditSink((r) => got.push(r));
    hub.setHubProject("alpha", A, "Settings");
    expect(got.map((r) => r.verb).sort()).toEqual(["config-write", "hub-link"]);
    expect(rows()).toHaveLength(0);
  });
});

describe("links seen (doctor's lost-link check)", () => {
  it("a link lost without an unlink is reported; an unlink is not", () => {
    hub.setHubProject("alpha", A, "Settings");
    // beta's link was on disk before any write: the first write notes it.
    expect(Object.keys(seen.readLinksSeen()).sort()).toEqual(["alpha", "beta"]);

    hub.setHubProject("alpha", null, "Settings");
    const f = ws.readWorkspacesFile();
    delete (f.workspaces.beta as { hub_project?: unknown }).hub_project;
    ws.writeWorkspacesFile(f, "a stray writer");

    const lost = seen.lostHubLinks(ws.readWorkspacesFile().workspaces);
    expect(lost.map((l) => [l.ws, l.was.slug])).toEqual([["beta", "def"]]);
  });

  it("a removed project is not a lost link", () => {
    hub.setHubProject("beta", B, "Settings");
    hub.setHubProject("alpha", A, "Settings");
    const f = ws.readWorkspacesFile();
    delete f.workspaces.beta;
    ws.writeWorkspacesFile(f, "remove");
    expect(seen.lostHubLinks(ws.readWorkspacesFile().workspaces)).toEqual([]);
  });
});
