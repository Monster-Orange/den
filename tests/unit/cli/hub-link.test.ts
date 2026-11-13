/**
 * H5 (Ward: "how do I reconnect a project ... with the project in den
 * hub?!"): `hub link -p <project> [<hub project> | --none]` shows, sets or
 * clears the Hub project a project works on. Hub's suggestions are shown;
 * the person names one. A person's ask only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cmdHubLink,
  type HubLinkDeps,
} from "../../../src/ui/cli/hub-link-command.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import { ACTOR_TOKEN_ENV } from "../../../src/shared/actor-token.js";

const BACK = {
  id: "proj_backoffice",
  slug: "back-office",
  name: "Back Office",
};
const SITE = { id: "proj_site", slug: "site", name: "Site" };

function rig(over: Partial<HubLinkDeps> = {}) {
  const store = new Map<string, HubProjectLink | null>();
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const deps: HubLinkDeps = {
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    resolveProject: (t) =>
      ({ "back-office": "back-office", "Back Office": "back-office" })[t] ??
      null,
    choices: async (ws) => {
      asked.push(ws);
      return {
        suggestions: [{ ...BACK, why: "name" as const }],
        projects: [BACK, SITE],
      };
    },
    read: (ws) => store.get(ws) ?? null,
    write: (ws, l) => void store.set(ws, l),
    ...over,
  };
  return { deps, store, out, err, asked };
}

describe("hub link (H5)", () => {
  it("no Hub project named: says it isn't linked and offers Hub's suggestion, writing nothing", async () => {
    const r = rig();
    expect(await cmdHubLink(["-p", "Back Office"], r.deps)).toBe(0);
    expect(r.asked).toEqual(["back-office"]);
    expect(r.out.join("\n")).toContain(
      "back-office is not linked to a Hub project",
    );
    expect(r.out.join("\n")).toContain(
      "Back Office (back-office): same name. Link:",
    );
    expect(r.out.join("\n")).toContain("hub link -p back-office back-office");
    expect(r.out.join("\n")).toContain("Site");
    expect(r.store.size).toBe(0);
  });

  it("links by the Hub project's slug, name or id; --none unlinks", async () => {
    const r = rig();
    expect(await cmdHubLink(["-p", "back-office", "Site"], r.deps)).toBe(0);
    expect(r.store.get("back-office")).toEqual(SITE);
    expect(
      await cmdHubLink(
        ["-p", "back-office", "proj_backoffice", "--json"],
        r.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(r.out.at(-1)!)).toEqual({
      ok: true,
      project: "back-office",
      hub: BACK,
    });
    expect(await cmdHubLink(["-p", "back-office", "--none"], r.deps)).toBe(0);
    expect(r.store.get("back-office")).toBeNull();
  });

  it("refuses a Hub project the company doesn't have, a project that doesn't exist, and an agent", async () => {
    const r = rig();
    expect(await cmdHubLink(["-p", "back-office", "nope"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toContain('no Hub project "nope"');
    expect(await cmdHubLink(["-p", "ghost", "site"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toContain('there is no project "ghost"');
    const a = rig({ env: { [ACTOR_TOKEN_ENV]: "den_at_x" } });
    expect(await cmdHubLink(["-p", "back-office", "site"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toContain("a person's ask");
    expect(a.store.size).toBe(0);
  });

  it("Hub not connected: says how to connect", async () => {
    const r = rig({ choices: async () => null });
    expect(await cmdHubLink(["-p", "back-office"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toContain("isn't connected to Hub");
  });
});

describe("hub link --suggested (#68)", () => {
  const sug = (over: Partial<HubLinkDeps> = {}) =>
    rig({
      projects: () => ["back-office", "lone", "site"],
      choices: async (ws) =>
        ws === "lone"
          ? { suggestions: [], projects: [BACK, SITE] }
          : {
              suggestions: [{ ...BACK, why: "repo" as const }],
              projects: [BACK, SITE],
            },
      link: (p) => `https://den.example.test${p}`,
      ...over,
    });

  it("lists each unlinked project's suggestion and the page that links them; writes nothing", async () => {
    const r = sug();
    r.store.set("site", { id: SITE.id, slug: SITE.slug, name: SITE.name });
    expect(await cmdHubLink(["--suggested"], r.deps)).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain("Hub suggests (1):");
    expect(text).toContain("back-office → Back Office (back-office)");
    expect(text).toContain(
      "Link them in one go: https://den.example.test/settings#agents.hub_link_all",
    );
    expect(text).toContain("lone: no suggestion");
    expect(text).not.toContain("site →");
    expect(r.store.get("back-office")).toBeUndefined();
  });

  it("--json: every row and the page", async () => {
    const r = sug();
    expect(await cmdHubLink(["--suggested", "--json"], r.deps)).toBe(0);
    const j = JSON.parse(r.out[0]) as {
      projects: { project: string; suggestion: { slug: string } | null }[];
      page: string;
    };
    expect(
      j.projects.map((p) => [p.project, p.suggestion?.slug ?? null]),
    ).toEqual([
      ["back-office", "back-office"],
      ["lone", null],
      ["site", "back-office"],
    ]);
    expect(j.page).toBe(
      "https://den.example.test/settings#agents.hub_link_all",
    );
  });

  it("Hub not connected: says so, exit 1; with -p or a Hub project: usage", async () => {
    const r = sug({ choices: async () => null });
    expect(await cmdHubLink(["--suggested"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toContain("isn't connected to Hub");
    expect(await cmdHubLink(["--suggested", "-p", "site"], sug().deps)).toBe(2);
  });
});
