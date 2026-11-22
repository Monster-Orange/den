/**
 * Issue 646 (one Connect flow, shape B): after Connect, one review in
 * Settings › Hub. A row per project with its proposed Hub project and
 * why (the same repo, then the name; "Create <name>" when none fits), a
 * link to another Hub said as such, and one button that links every row at
 * once and asks Hub for every new project as one plan an owner applies in
 * Hub. Live-check clause 6: three projects (one by repo, one by name, one
 * with none) end linked, the third asked of Hub, after that one press.
 * Fakes for Hub; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import type { HubCreate } from "../../../src/shared/hub-project-create.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import {
  applyReview,
  hubReviewRoute,
  reviewCount,
  reviewRows,
  type HubReviewDeps,
} from "../../../src/ui/server/hub-connect-review.js";

const P = {
  web: { id: "proj_web1", slug: "web", name: "Web" },
  docs: { id: "proj_docs1", slug: "docs", name: "Docs" },
  other: { id: "proj_other1", slug: "other", name: "Other" },
};

function fake(over: Partial<HubReviewDeps> = {}) {
  const links = new Map<string, HubProjectLink>();
  const asks = new Map<string, HubCreate>();
  const audit: string[] = [];
  const plans: { names: string[]; reason: string }[] = [];
  let changed = 0;
  let picked = 0;
  const suggest: Record<
    string,
    { id: string; slug: string; name: string; why: "repo" | "name" }[]
  > = {
    north: [{ ...P.web, why: "repo" }],
    south: [{ ...P.docs, why: "name" }],
    east: [],
    west: [
      { ...P.web, why: "name" },
      { ...P.docs, why: "name" },
    ],
  };
  const d: HubReviewDeps = {
    projects: () => ["north", "south", "east"],
    name: (ws) => ws[0].toUpperCase() + ws.slice(1),
    choices: async (ws) => ({
      suggestions: suggest[ws] ?? [],
      projects: [P.web, P.docs, P.other],
    }),
    read: (ws) => links.get(ws) ?? null,
    elsewhere: () => null,
    was: () => null,
    waiting: (ws) => {
      const a = asks.get(ws);
      return a && !a.outcome ? a : null;
    },
    write: (ws, l) => void links.set(ws, l),
    keepCreate: (ws, c) => void (c ? asks.set(ws, c) : asks.delete(ws)),
    plan: async (names, reason) => {
      plans.push({ names, reason });
      return {
        held: "held_1",
        url: "https://hub.example.test/plans/held_1",
        made: names.map((n) => ({ name: n, slug: n.toLowerCase() })),
      };
    },
    changed: () => void changed++,
    audit: (l) => void audit.push(l),
    picked: (n) => void (picked += n),
    now: () => new Date("2026-11-20T10:00:00Z"),
    ...over,
  };
  return {
    d,
    links,
    asks,
    audit,
    plans,
    suggest,
    changed: () => changed,
    picked: () => picked,
  };
}

describe("issue 646: the review rows", () => {
  it("proposes by repo, then by name, else Create <name>, each with why", async () => {
    const f = fake();
    const r = await reviewRows(f.d);
    expect(r.connected).toBe(true);
    expect(r.projects.map((p) => p.id)).toEqual([
      P.web.id,
      P.docs.id,
      P.other.id,
    ]);
    expect(r.rows.map((x) => [x.project, x.proposal])).toEqual([
      ["north", { kind: "link", hub: P.web, why: "repo" }],
      ["south", { kind: "link", hub: P.docs, why: "name" }],
      ["east", { kind: "create", name: "East" }],
    ]);
  });

  it("an unclear one asks for a pick, listing its choices", async () => {
    const f = fake({ projects: () => ["west"] });
    const [row] = (await reviewRows(f.d)).rows;
    expect(row.proposal).toEqual({
      kind: "pick",
      choices: [
        { ...P.web, why: "name" },
        { ...P.docs, why: "name" },
      ],
    });
  });

  it("a linked one shows its link and why; a waiting create shows it is waiting", async () => {
    const f = fake();
    f.links.set("north", P.web);
    f.asks.set("east", {
      held: "h9",
      name: "East",
      slug: "east",
      url: "https://hub.example.test/plans/h9",
      askedAt: "2026-11-20T09:00:00.000Z",
      by: "person",
    });
    const rows = (await reviewRows(f.d)).rows;
    expect(rows[0]).toMatchObject({
      project: "north",
      linked: { ...P.web, why: "repo" },
      proposal: null,
    });
    expect(rows[2]).toMatchObject({
      project: "east",
      waiting: { name: "East", url: "https://hub.example.test/plans/h9" },
      proposal: null,
    });
  });

  it("a link to another Hub, and the one archived on a Hub change, are said", async () => {
    const f = fake({
      elsewhere: (ws) =>
        ws === "north"
          ? {
              ...P.web,
              hub: { origin: "https://old.example.test", company: "acme" },
            }
          : null,
      was: (ws) =>
        ws === "south"
          ? { name: "Docs old", origin: "https://old.example.test" }
          : null,
    });
    const rows = (await reviewRows(f.d)).rows;
    expect(rows[0].elsewhere).toEqual({
      name: "Web",
      origin: "https://old.example.test",
      company: "acme",
    });
    expect(rows[0].proposal).toMatchObject({ kind: "link" });
    expect(rows[1].was).toEqual({
      name: "Docs old",
      origin: "https://old.example.test",
    });
  });

  it("Hub not answering: not connected, and no proposals", async () => {
    const f = fake({ choices: async () => null });
    const r = await reviewRows(f.d);
    expect(r.connected).toBe(false);
    expect(r.rows.every((x) => x.proposal === null)).toBe(true);
  });
});

describe("issue 646: after Connect, nothing links before the press (the approved mock)", () => {
  it("clear matches wait as suggested rows; Connect only counts them", async () => {
    const f = fake();
    expect(await reviewCount(f.d)).toEqual({ review: 3 });
    expect(f.links.size).toBe(0);
    expect(f.asks.size).toBe(0);
    expect(f.plans).toHaveLength(0);
    expect(f.changed()).toBe(0);
    // The clear one is still a proposal, like every other row.
    expect((await reviewRows(f.d)).rows[0].proposal).toMatchObject({
      kind: "link",
      why: "repo",
    });
  });

  it("issue 649: the catch-all project `default` is never a row, never counted, never linked", async () => {
    const f = fake({ projects: () => ["default", "north"] });
    f.suggest.default = [{ ...P.web, why: "name" }];
    expect((await reviewRows(f.d)).rows.map((r) => r.project)).toEqual([
      "north",
    ]);
    expect(await reviewCount(f.d)).toEqual({ review: 1 });
    const r = await applyReview(
      f.d,
      [{ project: "default", hub: P.web.id }],
      "t",
    );
    expect(r.skipped.map((s) => s.code)).toEqual(["unknown"]);
    expect(f.links.size).toBe(0);
  });

  it("Hub not answering: cannot; every project linked: none to review", async () => {
    expect(await reviewCount(fake({ choices: async () => null }).d)).toEqual({
      cannot: true,
    });
    const f = fake();
    f.links.set("north", P.web);
    f.links.set("south", P.docs);
    f.links.set("east", P.other);
    expect(await reviewCount(f.d)).toEqual({ review: 0 });
  });
});

describe("issue 646: Connect and link all (clause 6)", () => {
  it("three projects: two linked at once, the third asked of Hub as one plan", async () => {
    const f = fake();
    const rows = (await reviewRows(f.d)).rows;
    const r = await applyReview(
      f.d,
      rows.map((x) =>
        x.proposal?.kind === "link"
          ? { project: x.project, hub: x.proposal.hub.id }
          : {
              project: x.project,
              create: (x.proposal as { name: string }).name,
            },
      ),
      "Settings › Hub (person:test)",
    );
    expect(r.linked).toEqual([
      { project: "north", hub: P.web, why: "repo" },
      { project: "south", hub: P.docs, why: "name" },
    ]);
    expect(r.creating).toEqual([
      { project: "east", name: "East", slug: "east" },
    ]);
    expect(r.plan).toEqual({ url: "https://hub.example.test/plans/held_1" });
    expect(r.skipped).toEqual([]);
    expect(f.links.get("north")?.id).toBe(P.web.id);
    expect(f.links.get("south")?.id).toBe(P.docs.id);
    expect(f.asks.get("east")).toMatchObject({
      held: "held_1",
      name: "East",
      slug: "east",
      by: "person",
    });
    expect(f.plans).toHaveLength(1);
    expect(f.plans[0].names).toEqual(["East"]);
    expect(f.changed()).toBe(1);
    expect(f.audit).toHaveLength(3);
    // Every project now linked or asked: nothing left to review.
    const after = (await reviewRows(f.d)).rows;
    expect(after.every((x) => x.proposal === null)).toBe(true);
  });

  it("several creates go to Hub as one plan", async () => {
    const f = fake({ projects: () => ["east", "far"] });
    await applyReview(
      f.d,
      [
        { project: "east", create: "East" },
        { project: "far", create: "Far" },
      ],
      "t",
    );
    expect(f.plans).toEqual([
      { names: ["East", "Far"], reason: expect.stringContaining("Connect") },
    ]);
    expect(f.asks.get("far")?.held).toBe("held_1");
  });

  it("any of the company's projects may be chosen, not only the suggestion; a pick counts down the bell", async () => {
    const f = fake({ projects: () => ["west"] });
    const r = await applyReview(
      f.d,
      [{ project: "west", hub: P.other.id }],
      "t",
    );
    expect(r.linked).toEqual([
      { project: "west", hub: P.other, why: "picked" },
    ]);
    expect(f.picked()).toBe(1);
  });

  it("the bell counts down every project the press settled: links and creates", async () => {
    const f = fake();
    await applyReview(
      f.d,
      [
        { project: "north", hub: P.web.id },
        { project: "south", hub: P.docs.id },
        { project: "east", create: "East" },
      ],
      "t",
    );
    expect(f.picked()).toBe(3);
  });

  it("skips, saying why: unknown project, a Hub project not the company's, one already linked the same", async () => {
    const f = fake();
    f.links.set("north", P.web);
    const r = await applyReview(
      f.d,
      [
        { project: "nope", hub: P.web.id },
        { project: "south", hub: "proj_notours" },
        { project: "north", hub: P.web.id },
      ],
      "t",
    );
    expect(r.linked).toEqual([]);
    expect(r.skipped.map((s) => [s.project, s.code])).toEqual([
      ["nope", "unknown"],
      ["south", "stale"],
      ["north", "linked"],
    ]);
    expect(f.changed()).toBe(0);
  });

  it("a linked project chosen anew is relinked (Change)", async () => {
    const f = fake();
    f.links.set("north", P.web);
    const r = await applyReview(
      f.d,
      [{ project: "north", hub: P.other.id }],
      "t",
    );
    expect(r.linked[0]).toMatchObject({ project: "north", hub: P.other });
    expect(f.links.get("north")?.id).toBe(P.other.id);
  });

  it("Hub refusing the plan: the links still apply, the creates are skipped with Hub's words", async () => {
    const f = fake({
      plan: async () => {
        throw new Error("Hub answered 403: owners only");
      },
    });
    const r = await applyReview(
      f.d,
      [
        { project: "north", hub: P.web.id },
        { project: "east", create: "East" },
      ],
      "t",
    );
    expect(r.linked.map((x) => x.project)).toEqual(["north"]);
    expect(r.creating).toEqual([]);
    expect(r.skipped).toEqual([
      { project: "east", code: "hub", why: "Hub answered 403: owners only" },
    ]);
  });

  it("a create for a project with an ask waiting is skipped", async () => {
    const f = fake();
    f.asks.set("east", {
      held: "h9",
      name: "East",
      slug: "east",
      askedAt: "2026-11-20T09:00:00.000Z",
      by: "person",
    });
    const r = await applyReview(
      f.d,
      [{ project: "east", create: "East" }],
      "t",
    );
    expect(r.skipped.map((s) => s.code)).toEqual(["waiting"]);
    expect(f.plans).toHaveLength(0);
  });
});

describe("issue 646 review: Hub calls, duplicates, no token (review asks)", () => {
  it("asks Hub about at most 6 projects at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const many = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const f = fake({
      projects: () => many,
      choices: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { suggestions: [], projects: [P.web] };
      },
    });
    const r = await reviewRows(f.d);
    expect(r.rows).toHaveLength(20);
    expect(r.connected).toBe(true);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
  });

  it("a project listed twice is skipped as a duplicate, not as unknown", async () => {
    const f = fake();
    const r = await applyReview(
      f.d,
      [
        { project: "north", hub: P.web.id },
        { project: "north", hub: P.docs.id },
      ],
      "t",
    );
    expect(r.linked.map((x) => x.project)).toEqual(["north"]);
    expect(r.skipped).toEqual([
      { project: "north", code: "duplicate", why: "listed twice" },
    ]);
  });

  it("GET's body never carries a token", async () => {
    const f = fake({
      choices: async (ws) => ({
        suggestions: ws === "north" ? [{ ...P.web, why: "repo" }] : [],
        projects: [
          { ...P.web, token: "hubtok_secret", auth: "Bearer x" } as never,
          P.docs,
        ],
      }),
    });
    let body = "";
    const res = {
      writeHead: () => res,
      setHeader: () => undefined,
      end: (b: string) => void (body = b),
    };
    await hubReviewRoute(
      { method: "GET", headers: {} } as never,
      res as never,
      f.d,
      "t",
    );
    expect(body).toContain('"rows"');
    expect(body).not.toMatch(/token|Bearer/i);
  });
});
