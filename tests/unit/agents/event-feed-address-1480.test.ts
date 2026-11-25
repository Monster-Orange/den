/**
 * Issue 1480 (Reviewer C, Lane 1): where a feed may point.
 * - Den's own addresses (web.url, its port on this machine, the edge's
 *   names) and Hub's are refused outright: a bearer there goes to Den's
 *   own routes, and the stream loops Den's own events.
 * - A feed whose address is this machine, a private or a link-local
 *   network (resolved at the check) needs the person's own Allow on
 *   every install: app_feed_read would read local services.
 * - A public https feed with no bearer stays routine on a personal
 *   install, and is written public_only: at each connect its address is
 *   resolved again, and one that now names a private address is refused.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  feedAddressLocal,
  isPublicAddress,
} from "../../../src/shared/agents/feed-address.js";
import { criticalWhy } from "../../../src/shared/approval-policy.js";
import {
  checkEventFeedAdd,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const answers: Record<string, string[]> = {
  "chat.example.test": ["93.184.216.34"],
  "inside.example.test": ["10.1.2.3"],
  "mixed.example.test": ["93.184.216.34", "192.168.1.9"],
};
const lookup: Lookup = async (host) => {
  const a = answers[host];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
};

describe("issue 1480: which addresses are public", () => {
  it("loopback, private, link-local, shared and unique-local addresses aren't", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::5",
      "::ffff:127.0.0.1",
    ])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ["93.184.216.34", "2606:4700::1111"])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });

  it("a name is local when any of its addresses is, or when it can't be resolved", async () => {
    const local = (u: string) => feedAddressLocal(u, lookup);
    expect(await local("https://chat.example.test/events")).toBe(false);
    expect(await local("https://inside.example.test/events")).toBe(true);
    expect(await local("https://mixed.example.test/events")).toBe(true);
    expect(await local("https://gone.example.test/events")).toBe(true);
    expect(await local("http://localhost:7000/events")).toBe(true);
    expect(await local("http://app.localhost/events")).toBe(true);
    expect(await local("https://[::1]/events")).toBe(true);
    expect(await local("https://10.9.8.7/events")).toBe(true);
  });
});

describe("issue 1480: project_event_feed_add's address rules", () => {
  async function deps() {
    const r = await rig({
      workspaceEventFeeds: () => undefined,
      saveWorkspaceEventFeeds: () => undefined,
      feedLookup: lookup,
      feedOwnAddresses: async () => ({
        hosts: ["den.example.test", "hub.example.test"],
        domains: ["edge.example.test"],
        ports: [7777],
      }),
    });
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    return resolveAgentsDeps(r.deps);
  }
  const ask = (
    d: Awaited<ReturnType<typeof deps>>,
    a: Record<string, unknown>,
  ) =>
    checkEventFeedAdd(d, {
      project: "north",
      name: "chat",
      agent: "planner",
      url: "https://chat.example.test/events",
      ...a,
    });

  it("refuses Den's own web address, its port here, the edge's names and Hub's address", async () => {
    const d = await deps();
    for (const url of [
      "https://den.example.test/api/notifications/stream",
      "https://DEN.example.test:443/x",
      "http://127.0.0.1:7777/api/events",
      "http://localhost:7777/api/events",
      "https://edge.example.test/x",
      "https://north.edge.example.test/x",
      "https://hub.example.test/api/events",
    ]) {
      const c = await ask(d, { url });
      expect([url, c.ok]).toEqual([url, false]);
      if (!c.ok) expect(c.error).toContain("points at Den or its Hub itself");
    }
    const viaList = await ask(d, {
      list_url: "https://hub.example.test/list",
    });
    expect(viaList).toMatchObject({
      ok: false,
      error: expect.stringContaining("list_url"),
    });
  });

  it("a local or private address needs the person's own Allow, even on a personal install", async () => {
    const d = await deps();
    for (const url of [
      "http://localhost:7000/events",
      "https://inside.example.test/events",
      "https://mixed.example.test/events",
    ]) {
      const c = await ask(d, { url });
      if (!c.ok) throw new Error(`${url}: ${c.error}`);
      expect([url, c.personOnly]).toEqual([url, true]);
      expect(criticalWhy("project_event_feed_add", true, [], "personal")).toBe(
        "critical",
      );
      expect(c.args.feed.publicOnly).toBeUndefined();
    }
    const viaList = await ask(d, {
      list_url: "https://inside.example.test/list",
    });
    expect(viaList).toMatchObject({ ok: true, personOnly: true });
  });

  it("a public feed with no bearer stays routine, and is written public_only", async () => {
    const d = await deps();
    const c = await ask(d, {});
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBeUndefined();
    expect(c.args.feed.publicOnly).toBe(true);
    expect(criticalWhy("project_event_feed_add", false, [], "personal")).toBe(
      null,
    );
  });
});
