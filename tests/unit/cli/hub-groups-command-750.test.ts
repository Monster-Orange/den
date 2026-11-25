/**
 * Issue 750: `den hub groups [--fresh]` prints the groups read as the
 * Agents page gets it (GET /api/hub/groups), as one line of JSON: the
 * same answer, from the same code (groupsView). A live check reads groups
 * this way where a page's own read isn't open to it. Off never asks Hub.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { cmdHub } from "../../../src/ui/cli/hub-command.js";
import type { HubGroupsDeps } from "../../../src/ui/server/hub-groups-routes.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

const GROUPS = {
  team: "acme",
  rule: "advise",
  groups: [
    {
      name: "Web Delivery",
      slug: "web-delivery",
      all: "web-delivery/all",
      address: "web-delivery/lead",
      lead: {
        name: "Web Planner",
        kind: "agent",
        of: "pat",
        install: "Bench",
        agent_id: "planner",
      },
      escalates_to: "pat",
      members: [],
    },
  ],
};

async function stubHub() {
  let calls = 0;
  const s = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(GROUPS));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    calls: () => calls,
  };
}

const deps = (url: string, mode: HubGroupsDeps["mode"]): HubGroupsDeps => ({
  hub: async () => ({ url, token: "tok_TESTONLY" }),
  company: () => "acme",
  self: async () => ({
    install: "Bench",
    login: "pat",
    features: ["groups.read"],
  }),
  cacheSeconds: () => 30,
  mode,
  cache: new Map(),
});

async function run(args: string[], d: HubGroupsDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdHub(["groups", ...args], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    groupsDeps: async () => d,
  });
  return { code, out, err };
}

describe("issue 750: den hub groups", () => {
  it("prints the groups read as one line of JSON", async () => {
    const hub = await stubHub();
    for (const mode of ["on", "auto"] as const) {
      const r = await run(
        ["--fresh"],
        deps(hub.url, () => mode),
      );
      expect(r.code).toBe(0);
      expect(r.out).toHaveLength(1);
      const j = JSON.parse(r.out[0]!);
      expect(j.state).toBe("ok");
      expect(j.groups[0].slug).toBe("web-delivery");
      expect(j.groups[0].lead.here).toBe(true);
      expect(j.groups[0].compose).toBe(
        `${hub.url}/acme/groups/web-delivery?compose=1`,
      );
    }
    expect(hub.calls()).toBe(2);
  });

  it("off: state off, and Hub is never asked", async () => {
    const hub = await stubHub();
    const r = await run(
      [],
      deps(hub.url, () => "off"),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toEqual({ ok: true, state: "off" });
    expect(hub.calls()).toBe(0);
  });

  it("anything else is a usage error", async () => {
    const hub = await stubHub();
    const r = await run(
      ["--json", "x"],
      deps(hub.url, () => "on"),
    );
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(
      /usage: .*hub <put\|pull\|push\|link\|groups>/,
    );
    expect(hub.calls()).toBe(0);
  });
});
