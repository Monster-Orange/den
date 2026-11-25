/**
 * Issue 646: Connect's review asks Hub for every new project as ONE plan
 * (the contract Den builds against: POST /api/projects/plan with several
 * {op: "create"} changes; one owner Apply in Hub makes them all). Slugs
 * never clash with Hub's or each other. Den links each once applied: with
 * several projects in one plan, by its own slug only. And the review says
 * which project a Hub change unlinked (previousLinkOf). Fakes only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hubPlanCreates } from "../../../src/shared/hub.js";
import { bindHub, previousLinkOf } from "../../../src/shared/hub-binding.js";
import {
  settleHubCreate,
  type HubCreate,
  type HubCreateDeps,
} from "../../../src/shared/hub-project-create.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";

const HUB = "https://hub.example.test";

function fakeFetch(answer: Record<string, unknown>) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    seen.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("issue 646: hubPlanCreates, one plan for several projects", () => {
  it("sends one plan with a create per name, slugs clear of Hub's and each other", async () => {
    const { f, seen } = fakeFetch({
      held: "held_7",
      state: "pending",
      url: `${HUB}/plans/held_7`,
    });
    const r = await hubPlanCreates(
      HUB,
      "hubi_TESTONLY_x1",
      { names: ["Web", "Web", "Docs"], reason: "Connect", taken: ["docs"] },
      { fetch: f as never },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${HUB}/api/projects/plan`);
    expect(seen[0].body).toEqual({
      changes: [
        { op: "create", slug: "web", name: "Web" },
        { op: "create", slug: "web-2", name: "Web" },
        { op: "create", slug: "docs-2", name: "Docs" },
      ],
      reason: "Connect",
    });
    expect(r).toEqual({
      held: "held_7",
      state: "pending",
      url: `${HUB}/plans/held_7`,
      made: [
        { name: "Web", slug: "web" },
        { name: "Web", slug: "web-2" },
        { name: "Docs", slug: "docs-2" },
      ],
    });
  });

  it("refuses no names, and a page link that isn't http(s) is dropped", async () => {
    await expect(
      hubPlanCreates(HUB, "t", { names: [], reason: "r" }),
    ).rejects.toThrow(/no projects/);
    const { f } = fakeFetch({ held: "h", url: "javascript:alert(1)" });
    const r = await hubPlanCreates(
      HUB,
      "hubi_TESTONLY_x1",
      { names: ["A", "B"], reason: "r" },
      { fetch: f as never },
    );
    expect(r.url).toBeUndefined();
  });
});

describe("issue 646: settling one plan that made several projects", () => {
  it("links each project by its own slug, never another's", async () => {
    const links = new Map<string, HubProjectLink>();
    const asks = new Map<string, HubCreate>([
      [
        "east",
        {
          held: "held_7",
          name: "East",
          slug: "east",
          askedAt: "2026-11-20T10:00:00.000Z",
          by: "person",
        },
      ],
    ]);
    const d: HubCreateDeps = {
      exists: () => true,
      linked: (ws) => links.get(ws) ?? null,
      asked: (ws) => asks.get(ws) ?? null,
      hub: async () => ({ url: HUB, token: "t" }),
      taken: async () => [],
      keep: (ws, c) => void (c ? asks.set(ws, c) : asks.delete(ws)),
      link: (ws, l) => void links.set(ws, l),
      changed: () => undefined,
      outcome: async () => ({
        held: "held_7",
        state: "applied",
        decidedAt: null,
        projects: [
          { id: "proj_far1", slug: "far", name: "Far", url: null },
          { id: null, slug: "east", name: "East", url: null },
        ],
      }),
    };
    // East's own project has no id yet: it waits, never takes Far's.
    expect((await settleHubCreate(d, "east")).state).toBe("pending");
    expect(links.get("east")).toBeUndefined();
  });
});

describe("issue 646: previousLinkOf", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub646-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the link a project had on the Hub before the change", () => {
    let ws: WorkspacesFile = {
      active: [],
      workspaces: {
        north: {
          hub_project: { id: "proj_n1", slug: "north", name: "North" },
        } as never,
      },
    };
    const d = {
      stateDir: dir,
      readWorkspaces: () => structuredClone(ws),
      writeWorkspaces: (f: WorkspacesFile) => void (ws = f),
    };
    bindHub(d, { url: "https://one.example.test", company: "acme" });
    bindHub(d, { url: "https://two.example.test", company: "acme" });
    expect(previousLinkOf(dir, "north")).toEqual({
      name: "North",
      origin: "https://one.example.test",
      company: "acme",
    });
    expect(previousLinkOf(dir, "south")).toBeNull();
  });
});
