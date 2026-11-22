/**
 * Issue 648: one approval for the connection, every link and every create.
 * Connect sends Hub's Connect page the projects (`review=1&projects=…`);
 * Hub's page shows each one's link or create, and applies them with the
 * connection. Den takes the mapping back with the token and stores every
 * link: no second approval, no plan page. An older Hub (no `review` in its
 * answer) falls back to issue 646's flow, and Connect says so. Live-check
 * clauses 1 and 2. Fakes for Hub; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import {
  HubConnect,
  type HubConnectDeps,
} from "../../../src/ui/server/hub-connect.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";

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
) {
  const links = new Map<string, HubProjectLink>();
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
    expect(f.links.get("east")).toEqual({
      id: "p_east",
      slug: "east",
      name: "East",
    });
    expect(r?.ok).toBe(true);
    expect(r?.message).toBe(
      "Connected to Hub (Acme Co). Linked 3 projects in the same approval (1 new).",
    );
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
    expect(r?.message).toContain("Linked 2 projects in the same approval.");
    expect(r?.message).toContain(
      "east: not created (members can't create projects).",
    );
    expect(r?.message).toContain("Review 1 project below");
  });
});

describe("issue 648: an older Hub falls back to issue 646's flow (clause 2)", () => {
  it("no review in Hub's answer: nothing linked by Connect, and it says so", async () => {
    const f = hc(() => undefined);
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(f.reviewed()).toBe(1);
    expect(r?.message).toBe(
      "Connected to Hub (Acme Co). This Hub doesn't link projects in Connect yet, so they wait for your review here. Review 3 projects below, then press Connect and link all.",
    );
  });

  it("a review for another list (its hash): dropped, and said", async () => {
    const f = hc(() => ALL("0".repeat(64)));
    const r = await f.finish(f.start());
    expect(f.links.size).toBe(0);
    expect(r?.message).toContain(
      "Hub's answer is for another list of projects",
    );
  });
});
