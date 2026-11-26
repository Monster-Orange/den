/**
 * Issue 648: one approval for the connection, every link and every create.
 * Connect sends Hub's Connect page the projects (`review=1&projects=…`);
 * Hub's page shows each one's link or create, and applies them with the
 * connection. Den takes the mapping back with the token and stores every
 * link: no second approval, no plan page. An older Hub (no `review` in its
 * answer) falls back to issue 646's flow, and Connect says so. Live-check
 * clauses 1 and 2. Fakes for Hub; invented names only.
 *
 * Connect's summary is data (lastResult().words); Settings words it in
 * en/es/ja (settings-hub-words.test.ts). Security review: links are
 * written only after the rebind to this Hub resolved, and never over a
 * link to another Hub project.
 */
import { describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import {
  HubConnect,
  type HubConnectDeps,
} from "../../../src/ui/server/hub-connect.js";
import type { HubProjectLink } from "../../../src/shared/hub/hub-project-link.js";

const ORIGIN = "http://localhost:7300";
const HUB = "https://hub.example.test";
const PROJECTS = [
  { key: "north", name: "North", repos: ["acme/web"] },
  { key: "south", name: "South", repos: [] },
  { key: "east", name: "East", repos: [] },
];

function hc(
  review: (hash: string) => unknown,
  over: Partial<HubConnectDeps> = {},
  had: Record<string, HubProjectLink> = {},
) {
  const links = new Map<string, HubProjectLink>(Object.entries(had));
  let sentHash = "";
  let reviewed = 0;
  const h = new HubConnect({
    now: () => 1,
    config: () => null,
    exchange: async () => ({
      token: "hubi_TESTONLY_648",
      company: { name: "Acme Co", slug: "acme" },
      review: review(sentHash),
    }),
    revoke: async () => true,
    store: async () => ({ kind: "file", source: "file:/x", where: "/x" }),
    forget: async () => undefined,
    readToken: async () => null,
    readUser: () => ({}),
    writeUser: () => undefined,
    installLabel: () => "den on box",
    reviewProjects: () => PROJECTS,
    linkProject: (ws, l) => void links.set(ws, l),
    linkOf: (ws) => links.get(ws) ?? null,
    rebind: async () => ({ kind: "same" }),
    boundOrigin: () => HUB,
    reviewAfter: async () => {
      reviewed++;
      return { review: 3 - links.size };
    },
    ...over,
  });
  const start = () => {
    const r = h.start(ORIGIN, HUB);
    if (!r.ok) throw new Error(r.error);
    const q = new URL(r.location).searchParams;
    sentHash = q.get("projects")
      ? createHash("sha256").update(q.get("projects")!).digest("hex")
      : "";
    return q;
  };
  const finish = async (q: URLSearchParams) => {
    await h.finish(new URLSearchParams({ state: q.get("state")!, code: "c1" }));
    return h.lastResult();
  };
  return { h, links, start, finish, reviewed: () => reviewed };
}

const ALL = (hash: string) => ({
  version: 1,
  projects_hash: hash,
  links: [
    {
      key: "north",
      project: { id: "p_web", slug: "web", name: "Web" },
      how: "linked",
    },
    {
      key: "south",
      project: { id: "p_docs", slug: "docs", name: "Docs" },
      how: "linked",
    },
    {
      key: "east",
      project: { id: "p_east", slug: "east", name: "East" },
      how: "created",
    },
  ],
  skipped: [],
});

describe("issue 648: Connect sends the projects for Hub's page", () => {
  it("review=1 and projects=<base64url JSON>, never the catch-all", () => {
    const f = hc(() => undefined, {
      reviewProjects: () => [
        ...PROJECTS,
        { key: "default", name: "Default", repos: [] },
      ],
    });
    const q = f.start();
    expect(q.get("review")).toBe("1");
    const list = JSON.parse(
      Buffer.from(q.get("projects")!, "base64url").toString("utf8"),
    );
    expect(list.map((p: { key: string }) => p.key)).toEqual([
      "north",
      "south",
      "east",
    ]);
  });

  it("issue 1334: an empty project never goes to Hub's review page", () => {
    const f = hc(() => undefined, {
      reviewProjects: () => [
        ...PROJECTS,
        { key: "spare", name: "Spare", repos: [], empty: true },
      ],
    });
    const q = f.start();
    const list = JSON.parse(
      Buffer.from(q.get("projects")!, "base64url").toString("utf8"),
    );
    expect(list.map((p: { key: string }) => p.key)).toEqual([
      "north",
      "south",
      "east",
    ]);
  });

  it("past a cap: no review param (issue 646's flow), and Connect still starts", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      key: `p${i}`,
      name: `P${i}`,
      repos: [],
    }));
    const q = hc(() => undefined, { reviewProjects: () => many }).start();
    expect(q.has("review")).toBe(false);
    expect(q.has("projects")).toBe(false);
  });
});

describe("issue 648: one approval links every project (clause 1)", () => {
  it("three projects, one created: all linked from the token's answer, no plan, no review left", async () => {
    const f = hc(ALL);
    const r = await f.finish(f.start());
    expect([...f.links.keys()]).toEqual(["north", "south", "east"]);
    // Stamped with the Hub connected now, not whatever was bound before.
    expect(f.links.get("east")).toEqual({
      id: "p_east",
      slug: "east",
      name: "East",
      hub: { origin: HUB, company: "acme" },
    });
    expect(r?.ok).toBe(true);
    expect(r?.words).toEqual({
      team: "Acme Co",
      grant: { linked: 3, created: 1, skipped: [] },
      review: { n: 0 },
    });
  });

  it("a skipped project waits for 646's review, said in the summary", async () => {
    const f = hc((hash) => ({
      ...ALL(hash),
      links: ALL(hash).links.slice(0, 2),
      skipped: [
        {
          key: "east",
          why: "permission",
          detail: "members can't create projects",
        },
      ],
    }));
    const r = await f.finish(f.start());
    expect([...f.links.keys()]).toEqual(["north", "south"]);
    expect(r?.words).toEqual({
      team: "Acme Co",
      grant: {
        linked: 2,
        created: 0,
        skipped: [
          {
            key: "east",
            why: "permission",
            detail: "members can't create projects",
          },
        ],
      },
      review: { n: 1 },
    });
  });
});

describe("issue 648: an older Hub falls back to issue 646's flow (clause 2)", () => {
  it("no review in Hub's answer: nothing linked by Connect, and it says so", async () => {
    const f = hc(() => undefined);
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(f.reviewed()).toBe(1);
    expect(r?.words).toEqual({
      team: "Acme Co",
      grant: { fallback: "old-hub" },
      review: { n: 3 },
    });
  });

  it("a review for another list (its hash): dropped, and said", async () => {
    const f = hc(() => ALL("0".repeat(64)));
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(r?.words?.grant).toEqual({ fallback: "other-list" });
  });
});

describe("issue 648 security: links only for this Hub, never over another link", () => {
  it("the rebind rejects: nothing is linked, and the projects wait for the review", async () => {
    const f = hc(ALL, {
      rebind: async () => {
        throw new Error("state dir is read-only");
      },
    });
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(r?.words?.grant).toEqual({ fallback: "rebind" });
    expect(r?.words?.review).toEqual({ n: 3 });
  });

  it("the rebind resolved but the bound Hub is another one: nothing is linked", async () => {
    const f = hc(ALL, { boundOrigin: () => "https://old-hub.example.test" });
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(r?.words?.grant).toEqual({ fallback: "rebind" });
  });

  it("reading a project's link throws: that project is skipped as failed, never written", async () => {
    const f = hc(ALL, {
      linkOf: (ws) => {
        if (ws === "north") throw new Error("workspaces.yml unreadable");
        return null;
      },
    });
    const r = await f.finish(f.start());
    expect(f.links.has("north")).toBe(false);
    expect(r?.words?.grant).toEqual({
      linked: 2,
      created: 1,
      skipped: [{ key: "north", why: "failed" }],
    });
  });

  it("a project linked to another Hub project keeps its link and waits for the review; the same id is confirmed", async () => {
    const theirs = { id: "p_mine", slug: "mine", name: "Mine" };
    const same = { id: "p_docs", slug: "docs", name: "Docs" };
    const f = hc(ALL, {}, { north: theirs, south: same });
    const r = await f.finish(f.start());
    expect(f.links.get("north")).toEqual(theirs);
    expect(f.links.get("south")).toEqual({
      ...same,
      hub: { origin: HUB, company: "acme" },
    });
    expect(f.links.get("east")?.id).toBe("p_east");
    expect(r?.words?.grant).toEqual({
      linked: 2,
      created: 1,
      skipped: [{ key: "north", why: "person" }],
    });
  });
});
