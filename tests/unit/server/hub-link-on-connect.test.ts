/**
 * 0.4.45 (projects follow Connect): connecting the install links every
 * project whose Hub project is clear, and asks a person only where it
 * isn't. Unclear: two Hub projects share its repos, or its repos and its
 * name point to different ones. Hub without the suggest route (older, or
 * not answering): nothing is linked, and Connect says Hub can't link
 * projects yet.
 */
import { describe, expect, it } from "@jest/globals";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import {
  hubMatchOf,
  linkClearProjects,
  type HubLinkAllDeps,
} from "../../../src/ui/server/hub-link-all-routes.js";

const P = (id: string, why?: "repo" | "name") => ({
  id,
  slug: id,
  name: id.toUpperCase(),
  ...(why ? { why } : {}),
});

describe("which Hub project fits", () => {
  it("one by repos, or one by name: clear", () => {
    expect(hubMatchOf([P("web", "repo")])).toEqual({
      clear: P("web", "repo"),
    });
    expect(hubMatchOf([P("web", "repo"), P("web", "name")])).toMatchObject({
      clear: { id: "web" },
    });
    expect(hubMatchOf([P("web", "name")])).toMatchObject({
      clear: { id: "web" },
    });
  });

  it("two by repos, or repos and name apart: unclear, with both", () => {
    expect(hubMatchOf([P("a", "repo"), P("b", "repo")])).toEqual({
      unclear: [P("a", "repo"), P("b", "repo")],
    });
    expect(hubMatchOf([P("a", "repo"), P("b", "name")])).toEqual({
      unclear: [P("a", "repo"), P("b", "name")],
    });
  });

  it("nothing suggested: none", () => {
    expect(hubMatchOf([])).toEqual({ none: true });
  });
});

function deps(
  sugg: Record<string, ReturnType<typeof P>[] | null | "throw">,
  linked: Record<string, HubProjectLink> = {},
) {
  const written: Record<string, HubProjectLink> = {};
  let changed = 0;
  const d: HubLinkAllDeps = {
    projects: () => Object.keys(sugg).sort(),
    choices: async (ws) => {
      const s = sugg[ws];
      if (s === "throw") throw new Error("404");
      return s === null ? null : { suggestions: s, projects: [] };
    },
    read: (ws) => linked[ws] ?? written[ws] ?? null,
    write: (ws, l) => {
      written[ws] = l;
    },
    changed: () => {
      changed++;
    },
    audit: () => undefined,
  };
  return { d, written, changed: () => changed };
}

describe("Connect links the clear ones", () => {
  it("links each clear project, leaves the unclear and the linked; one sync", async () => {
    const t = deps(
      {
        north: [P("north", "repo")],
        south: [P("s1", "repo"), P("s2", "repo")],
        east: [],
        west: [P("other", "repo")],
      },
      { west: { id: "w", slug: "w", name: "W" } },
    );
    expect(await linkClearProjects(t.d)).toEqual({
      linked: ["north"],
      unclear: ["south"],
    });
    expect(t.written).toEqual({
      north: { id: "north", slug: "north", name: "NORTH" },
    });
    expect(t.changed()).toBe(1);
  });

  it("Hub can't suggest (an older Hub, or it doesn't answer): links nothing", async () => {
    for (const bad of ["throw", null] as const) {
      const t = deps({ north: [P("north", "repo")], south: bad });
      expect(await linkClearProjects(t.d)).toEqual({ cannot: true });
      expect(t.written).toEqual({});
      expect(t.changed()).toBe(0);
    }
  });
});

describe("Settings › Agents › Link projects to Hub: the unclear ones", () => {
  it("each choice to pick, none picked; Link ticked is there", async () => {
    const { hubLinkAllHtml } =
      await import("../../../src/ui/server/public/settings-registry.js");
    const html = hubLinkAllHtml(
      {
        connected: true,
        projects: [
          {
            project: "south",
            hub: null,
            suggestion: null,
            unclear: [P("s1", "repo"), P("s2", "name")],
          },
        ],
      },
      (k: string) => `[${k}]`,
    );
    expect(html).toContain('data-hubla-state="todo"');
    expect(html).toContain("[hubla.unclear]");
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => /name="hubla-pick-south"/.test(r))).toBe(true);
    expect(radios.some((r) => / checked/.test(r))).toBe(false);
    expect(radios[0]).toContain('data-hubla-hub="s1"');
    expect(html).toContain('data-hubla-action="link"');
  });
});
