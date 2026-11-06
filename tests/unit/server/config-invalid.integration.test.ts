/**
 * The web server with a config that fails validation (0.2.8-dev.2):
 *   - every config-reading API route answers 422
 *     `{ ok: false, error: "<the named message>", code: "config_invalid" }`
 *     as JSON, not a text/plain 500; the identity probe still answers.
 *   - a scoped MCP refusal that named a path (manifest_validate) is recorded
 *     under the catalog repo that path is inside, so that repo's activity
 *     shows it.
 *
 * The real web server in throwaway distributions; invented orgs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

let tmp = "";
let invalid: SlowGitServer;
let valid: SlowGitServer;
let checkout = "";

function distribution(name: string, orgs: string[], services: string[]) {
  const root = path.join(tmp, name);
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "github_org: acme", "orgs:", ...orgs, ""].join(
      "\n",
    ),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "widget: { gh: acme/widget }\ngadget: { gh: acme/gadget }\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [lab]",
      "focus: lab",
      "workspaces:",
      "  lab:",
      "    services:",
      ...services,
      "",
    ].join("\n"),
  );
  return root;
}

const MESSAGE =
  "config/den.yml: repo widget is claimed by both orgs.initech.repos and orgs.globex.repos";

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-config-invalid-")),
  );
  checkout = path.join(tmp, "checkouts", "widget");
  write(
    path.join(checkout, ".den.yml"),
    "version: 1\nname: widget\nservices:\n  widget: {}\n",
  );
  const gadget = path.join(tmp, "checkouts", "gadget");
  write(
    path.join(gadget, ".den.yml"),
    "version: 1\nname: gadget\nservices:\n  gadget: {}\n",
  );
  const services = [
    `      widget: { mode: dev-managed, path: ${checkout} }`,
    `      gadget: { mode: dev-managed, path: ${gadget} }`,
  ];
  invalid = await startSlowGitServer({
    tmp,
    root: distribution(
      "invalid",
      ["  initech: { repos: [widget] }", "  globex: { repos: [widget] }"],
      services,
    ),
    slow: [],
    delayS: 0,
  });
  valid = await startSlowGitServer({
    tmp,
    root: distribution("valid", ["  initech: { repos: [widget] }"], services),
    slow: [],
    delayS: 0,
  });
}, 90_000);

afterAll(async () => {
  await invalid?.stop();
  await valid?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function request(
  srv: SlowGitServer,
  p: string,
  init: RequestInit = {},
): Promise<{ status: number; type: string; body: string }> {
  const r = await fetch(`http://localhost:${srv.port}${p}`, init);
  return {
    status: r.status,
    type: r.headers.get("content-type") ?? "",
    body: await r.text(),
  };
}

describe("a config that fails validation is a JSON error naming its keys", () => {
  it.each([
    "/api/orgs",
    "/api/orgs?repos=1",
    "/api/services",
    "/api/workspaces",
  ])(
    "GET %s is 422 { ok: false, error, code: config_invalid }",
    async (p) => {
      const r = await request(invalid, p);
      expect(r.status).toBe(422);
      expect(r.type).toMatch(/^application\/json/);
      expect(JSON.parse(r.body)).toEqual({
        ok: false,
        error: MESSAGE,
        code: "config_invalid",
      });
    },
    30_000,
  );

  it("a mutating route is refused the same way, before it writes", async () => {
    const before = fs.readFileSync(
      path.join(tmp, "invalid", "config", "local", "workspaces.yml"),
      "utf-8",
    );
    const r = await request(invalid, "/api/workspaces/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "w2" }),
    });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body)).toMatchObject({ code: "config_invalid" });
    expect(
      fs.readFileSync(
        path.join(tmp, "invalid", "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toBe(before);
  }, 30_000);

  it("the identity probe still answers", async () => {
    expect((await request(invalid, "/api/server-info")).status).toBe(200);
  }, 30_000);
});

describe("a refused manifest_validate shows in its repo's activity", () => {
  const AGENT = {
    "content-type": "application/json",
    "x-den-actor": "agent",
    "x-den-mcp-client": "jest",
    "x-den-mcp-agent": "agent:planner",
    "x-den-mcp-workspace": "other",
  };
  const verbs = async (q: string): Promise<string[]> => {
    const r = await request(valid, `/api/activity?${q}`);
    expect(r.status).toBe(200);
    return (JSON.parse(r.body) as { entries: { verb: string }[] }).entries.map(
      (e) => e.verb,
    );
  };

  it("is recorded under the repo the path is inside, never as the path", async () => {
    const r = await request(valid, "/api/activity", {
      method: "POST",
      headers: AGENT,
      body: JSON.stringify({
        tool: "manifest_validate",
        path: path.join(checkout, ".den.yml"),
        reason: "manifest_validate: not inside a repo of workspace other",
      }),
    });
    expect(r.status).toBe(200);
    expect(await verbs("repo=widget")).toEqual(["manifest_validate"]);
    expect(await verbs("address=widget")).toEqual(["manifest_validate"]);
    expect(await verbs("repo=gadget")).toEqual([]);
    const all = (await request(valid, "/api/activity?repo=widget")).body;
    expect(all).not.toContain(checkout);
  }, 30_000);
});
