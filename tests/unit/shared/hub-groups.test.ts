/**
 * Issue 750: Den reads an install's groups from Hub (GET /api/groups) and
 * links to Hub's own group pages (Open, and Message group: Hub's composer,
 * the person's own Hub sign-in); it stores none. The contract lives in one
 * module (src/shared/hub-groups.ts). A stub Hub stands in. Invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  GROUPS_PATH,
  fetchHubGroups,
  groupComposeUrl,
  groupHubUrl,
  isOwnAgent,
  parseGroups,
} from "../../../src/shared/hub-groups.js";

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
      members: [
        {
          role: "planner",
          address: "web-delivery/planner",
          name: "Web Planner",
          kind: "agent",
          of: "pat",
          install: "Bench",
          agent_id: "planner",
        },
        {
          role: "review",
          address: "web-delivery/review",
          name: "Sam Example",
          kind: "person",
          of: "sam",
        },
      ],
    },
    {
      name: "Docs",
      slug: "docs",
      all: "docs/all",
      address: "docs/lead",
      lead: { name: "Pat Example", kind: "person", login: "pat" },
      escalates_to: "pat",
      members: [],
    },
  ],
};

async function stubHub(
  answer: (req: http.IncomingMessage, body: string) => [number, unknown],
): Promise<{
  url: string;
  seen: { method?: string; url?: string; auth?: string; body: string }[];
}> {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] =
    [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body,
      });
      const [status, json] = answer(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    seen,
  };
}

describe("issue 750: parseGroups (Hub's GET /api/groups)", () => {
  it("keeps the contract's fields, an agent lead and a person lead", () => {
    const g = parseGroups(GROUPS)!;
    expect(g.team).toBe("acme");
    expect(g.rule).toBe("advise");
    expect(g.groups).toHaveLength(2);
    expect(g.groups[0]).toMatchObject({
      name: "Web Delivery",
      slug: "web-delivery",
      all: "web-delivery/all",
      lead: { name: "Web Planner", kind: "agent", agentId: "planner" },
    });
    expect(g.groups[0].members[0]).toMatchObject({
      role: "planner",
      kind: "agent",
      agentId: "planner",
      install: "Bench",
    });
    expect(g.groups[0].members[1]).toMatchObject({
      kind: "person",
      name: "Sam Example",
    });
    expect(g.groups[0].members[1].agentId).toBeUndefined();
    expect(g.groups[1].lead).toEqual({
      name: "Pat Example",
      kind: "person",
      login: "pat",
    });
  });

  it("drops what isn't the shape; a bad answer is null", () => {
    expect(parseGroups(null)).toBeNull();
    expect(parseGroups({ groups: "x" })).toBeNull();
    const g = parseGroups({
      team: "acme",
      rule: "advise",
      groups: [
        { name: "No slug" },
        { name: "Ok", slug: "ok", members: [{ name: 5 }, null] },
        { name: "<b>", slug: "bad slug!" },
      ],
    })!;
    expect(g.groups.map((x) => x.slug)).toEqual(["ok"]);
    expect(g.groups[0].members).toEqual([]);
    expect(g.groups[0].all).toBe("ok/all");
  });

  it("a group's page in Hub: <hub>/<team>/groups/<slug>", () => {
    expect(
      groupHubUrl("https://hub.example.test/", "acme", "web-delivery"),
    ).toBe("https://hub.example.test/acme/groups/web-delivery");
    expect(groupHubUrl("https://hub.example.test", "", "x")).toBeNull();
  });
});

describe("issue 750: fetchHubGroups against a stub Hub", () => {
  it("reads GET /api/groups with the install's token", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const out = await fetchHubGroups(hub.url, "tok_TESTONLY");
    expect(out.state).toBe("ok");
    expect(out.state === "ok" && out.groups.groups).toHaveLength(2);
    expect(hub.seen[0]).toMatchObject({
      method: "GET",
      url: GROUPS_PATH,
      auth: "Bearer tok_TESTONLY",
    });
  });

  it("GR-T19: 403 groups_not_in_plan: unavailable", async () => {
    const hub = await stubHub(() => [
      403,
      { error: "Groups aren't part of this plan", code: "groups_not_in_plan" },
    ]);
    expect(await fetchHubGroups(hub.url, "t")).toEqual({
      state: "unavailable",
    });
  });

  it("GR-T19: 403 install_refused (Hub 0.2.29: the token's person is a guest) reads as a guest, by its code alone", async () => {
    const hub = await stubHub(() => [
      403,
      // The words even name the plan: only the code counts.
      { error: "groups_not_in_plan for guests", code: "install_refused" },
    ]);
    expect(await fetchHubGroups(hub.url, "t")).toEqual({ state: "refused" });
  });

  it("a 403 with no code (the token isn't an install's) shows no groups, never the guest line", async () => {
    const hub = await stubHub(() => [403, { error: "forbidden" }]);
    expect(await fetchHubGroups(hub.url, "t")).toEqual({
      state: "unreachable",
    });
  });

  it("a 403 with another code (not a guest, not the plan) shows no groups, never the guest line", async () => {
    const hub = await stubHub(() => [
      403,
      {
        error: "this install's grant doesn't cover agents",
        code: "agents_not_covered",
      },
    ]);
    expect(await fetchHubGroups(hub.url, "t")).toEqual({
      state: "unreachable",
    });
  });

  it("a Hub with no groups route (404 or 405): absent, not unreachable", async () => {
    for (const status of [404, 405]) {
      const hub = await stubHub(() => [status, { error: "not_found" }]);
      expect(await fetchHubGroups(hub.url, "t")).toEqual({ state: "absent" });
    }
  });

  it("401: the token isn't taken; Hub down or a 5xx: unreachable", async () => {
    const hub = await stubHub(() => [401, { error: "invalid_token" }]);
    expect((await fetchHubGroups(hub.url, "t")).state).toBe("rejected");
    expect(
      (await fetchHubGroups("http://127.0.0.1:9", "t", { timeoutMs: 500 }))
        .state,
    ).toBe("unreachable");
    const sick = await stubHub(() => [503, { error: "down" }]);
    expect((await fetchHubGroups(sick.url, "t")).state).toBe("unreachable");
  });
});

describe("issue 750: only this Den's own agents", () => {
  const self = { install: "Bench", login: "pat" };
  it("an agent on this install, of this Den's person", () => {
    expect(
      isOwnAgent(
        { kind: "agent", agentId: "planner", install: "Bench", of: "pat" },
        self,
      ),
    ).toBe(true);
  });
  it("another person's agent with the same id is not", () => {
    expect(
      isOwnAgent(
        { kind: "agent", agentId: "planner", install: "Bench", of: "sam" },
        self,
      ),
    ).toBe(false);
    expect(
      isOwnAgent(
        { kind: "agent", agentId: "planner", install: "Other", of: "pat" },
        self,
      ),
    ).toBe(false);
  });
  it("a person, or an agent with no id, is not", () => {
    expect(isOwnAgent({ kind: "person" }, self)).toBe(false);
    expect(isOwnAgent({ kind: "agent" }, self)).toBe(false);
  });
});

describe("issue 750: Message group opens Hub's composer", () => {
  it("<hub>/<company>/groups/<slug>?compose=1, to <slug>/all by default", () => {
    expect(
      groupComposeUrl("https://hub.example.test", "acme", "web-delivery"),
    ).toBe("https://hub.example.test/acme/groups/web-delivery?compose=1");
    expect(
      groupComposeUrl(
        "https://hub.example.test",
        "acme",
        "web-delivery",
        "web-delivery/review",
      ),
    ).toBe(
      // Hub's composer takes the role alone: &to=<role> (or all).
      "https://hub.example.test/acme/groups/web-delivery?compose=1&to=review",
    );
    // Another group's address, or a bad one: the default.
    expect(
      groupComposeUrl(
        "https://hub.example.test",
        "acme",
        "web-delivery",
        "docs/lead",
      ),
    ).toBe("https://hub.example.test/acme/groups/web-delivery?compose=1");
    expect(groupComposeUrl("ftp://hub.example.test", "acme", "x")).toBeNull();
  });
});
