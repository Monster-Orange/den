/**
 * Every route that changes something (route-classes.ts: `mutating` or
 * `shell-grade`), walked as an agent's token: each is refused to it (a
 * person's), or listed below with why an agent may call it. A new write
 * route that an agent reaches and that isn't listed fails, and so does a
 * listed one that is now refused (the list stays true).
 *
 * The walk asks the request guard's own check (agentRefusal), the one a
 * request with an actor token meets before any handler runs. It sends no
 * request: a route an agent may call runs real things.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let root = "";
const saved = {
  DEN_ROOT: process.env.DEN_ROOT,
  DEN_HOME: process.env.DEN_HOME,
};
let ROUTES: typeof import("../../../src/ui/server/route-classes.js").ROUTES;
let agentRefusal: typeof import("../../../src/ui/server/request-guard.js").agentRefusal;

beforeAll(async () => {
  // A distribution with no mcp.actions: no agent action is opted in.
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-agent-writes-")),
  );
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  process.env.DEN_ROOT = root;
  process.env.DEN_HOME = path.join(root, "home");
  ({ ROUTES } = await import("../../../src/ui/server/route-classes.js"));
  ({ agentRefusal } = await import("../../../src/ui/server/request-guard.js"));
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

/** `METHOD /path` (route-classes.ts's spelling) → why an agent may. */
const AGENTS_MAY: Record<string, string> = {
  "POST /api/approvals":
    "asks the person to allow a held write; nothing runs until they do",
  "POST /api/activity": "an agent's report of a refused call, appended only",
  "GET /api/service/exec":
    "MCP service lifecycle: up, down, restart, local only (checked for an agent)",
  "HEAD /api/service/exec": "as GET",
  "GET /api/run": "MCP tests_run: starts a test run",
  "HEAD /api/run": "as GET",
  "POST /api/workspace/sync": "MCP sync: git clone and pull in the checkouts",
  "GET /api/workspace/sync": "the same sync, streamed (as the page does)",
  "HEAD /api/workspace/sync": "as GET",
  "POST /api/manifest/validate": "validates posted content; writes nothing",
  "POST /api/report/preview": "composes a report's text; writes nothing",
  "POST /api/agents/self/attention":
    "NT-1: the agent's own waiting mark, by its own token only",
  "POST /hub/*": "D52: the agent's own Hub calls, with its own Hub token",
  "PUT /hub/*": "as POST",
  "DELETE /hub/*": "as POST",
};

const agent = {
  kind: "agent",
  actor: "agent:walker",
  workspace: "north",
  grants: [],
  session: { name: "walker-1", id: "walker-1" },
} as const;

/** A route's path as a request would have it: one value per parameter. */
const concrete = (p: string) =>
  p.replace(/:[A-Za-z]+/g, "x1").replace(/\*$/, "x1");

function writes() {
  const out: { key: string; open: boolean }[] = [];
  for (const r of ROUTES) {
    if (r.cls === "readonly") continue;
    for (const m of r.methods)
      out.push({
        key: `${m} ${r.path}`,
        // Service exec's query as the MCP tool sends it (its rule: below).
        open:
          agentRefusal(
            agent,
            m,
            concrete(r.path),
            r.cls,
            new URLSearchParams("cmd=up&env=local"),
          ) === null,
      });
  }
  return out;
}

describe("every route that changes something is a person's, or listed for agents", () => {
  it("walks the write routes", () => {
    const keys = writes().map((w) => w.key);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys).toEqual(
      expect.arrayContaining([
        "POST /api/settings",
        "POST /api/approvals/:id/decide",
        "POST /api/web/logout",
      ]),
    );
  });

  it("an agent reaches none that isn't listed with a reason", () => {
    expect(
      writes()
        .filter((w) => w.open && !(w.key in AGENTS_MAY))
        .map((w) => w.key),
    ).toEqual([]);
  });

  it("service exec: an agent runs up, down or restart, on local only", () => {
    const run = (q: string) =>
      agentRefusal(
        agent,
        "GET",
        "/api/service/exec",
        "mutating",
        new URLSearchParams(q),
      );
    for (const q of ["cmd=up&env=local", "cmd=down&env=local", "cmd=restart"])
      expect([q, run(q)]).toEqual([q, null]);
    for (const q of ["cmd=migrate&env=local", "cmd=up&env=prod", "env=local"])
      expect([q, run(q)]).toEqual([q, expect.stringMatching(/only/)]);
  });

  it("each listed one is a write route an agent does reach", () => {
    const open = new Set(
      writes()
        .filter((w) => w.open)
        .map((w) => w.key),
    );
    expect(Object.keys(AGENTS_MAY).filter((k) => !open.has(k))).toEqual([]);
    for (const [k, why] of Object.entries(AGENTS_MAY))
      expect([k, why.length > 5]).toEqual([k, true]);
  });
});
