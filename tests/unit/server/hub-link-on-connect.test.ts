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

  it("issue 649: never links the catch-all project `default`, even to a Hub project named default; never counts it as a pick", async () => {
    const t = deps({
      default: [P("default", "name")],
      north: [P("north", "repo")],
    });
    expect(await linkClearProjects(t.d)).toEqual({
      linked: ["north"],
      unclear: [],
    });
    expect(t.written).toEqual({
      north: { id: "north", slug: "north", name: "NORTH" },
    });
    const u = deps({ default: [P("a", "repo"), P("b", "name")] });
    expect(await linkClearProjects(u.d)).toEqual({ linked: [], unclear: [] });
    expect(u.written).toEqual({});
    expect(u.changed()).toBe(0);
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

describe("why a match is unclear (issue 167)", () => {
  it("two by repos; repos and name apart; two by name", async () => {
    const { unclearReason } =
      await import("../../../src/ui/server/hub-link-all-routes.js");
    expect(unclearReason([P("a", "repo"), P("b", "repo")])).toBe("repos");
    expect(
      unclearReason([P("a", "repo"), P("b", "repo"), P("c", "name")]),
    ).toBe("repos");
    expect(unclearReason([P("a", "repo"), P("b", "name")])).toBe("split");
    expect(unclearReason([P("a", "name"), P("b", "name")])).toBe("names");
  });

  it("GET says why on each unclear one", async () => {
    const http = await import("http");
    const { hubLinkAllRoute, HUB_LINK_ALL_PATH } =
      await import("../../../src/ui/server/hub-link-all-routes.js");
    const t = deps({ south: [P("s1", "repo"), P("s2", "name")] });
    const s = http.createServer(
      (req, res) => void hubLinkAllRoute(req, res, t.d),
    );
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const port = (s.address() as { port: number }).port;
      const b = (await (
        await fetch(`http://127.0.0.1:${port}${HUB_LINK_ALL_PATH}`)
      ).json()) as { projects: { project: string; reason?: string }[] };
      expect(b.projects.find((r) => r.project === "south")?.reason).toBe(
        "split",
      );
    } finally {
      s.close();
    }
  });
});

/**
 * Issue 167 (mock v6 B): Settings › Agents › Unclear matches. Each unclear
 * project in its own group: why, that nothing is filed for it yet, one
 * radio per Hub project (none picked), and its own Link, off until a pick.
 * Nothing unclear: the empty line. A clear one not linked yet keeps its own
 * Link, below.
 */
describe("Settings › Agents › Unclear matches", () => {
  const tt = (k: string, v?: Record<string, unknown>) =>
    `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;
  const html = async (projects: unknown[]) =>
    (
      await import("../../../src/ui/server/public/settings-registry.js")
    ).hubLinkAllHtml({ connected: true, projects }, tt);

  it("one group per unclear project: why, nothing filed, radios, its own Link off", async () => {
    const h = await html([
      {
        project: "south",
        hub: null,
        suggestion: null,
        reason: "repos",
        unclear: [P("s1", "repo"), P("s2", "repo")],
      },
      {
        project: "west",
        hub: null,
        suggestion: null,
        reason: "split",
        unclear: [P("w1", "repo"), P("w2", "name")],
      },
      { project: "east", hub: P("e1"), suggestion: null },
    ]);
    expect(h).toContain('data-hubla-state="todo"');
    expect(h).toContain("[ub.intro]");
    const groups = h.match(/<fieldset[^>]*data-hubla-row="[^"]+"/g) ?? [];
    expect(groups).toHaveLength(2);
    expect(h).toContain("[ub.why.repos]");
    expect(h).toContain("[ub.why.split]");
    expect(h).toContain("[ub.waiting]");
    expect(h).toMatch(/role="radiogroup"[^>]*aria-label="\[ub.pick:south\]"/);
    const radios = h.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(4);
    expect(radios.some((r) => / checked/.test(r))).toBe(false);
    const links = h.match(/<button[^>]*data-hubla-link="[^"]+"[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    expect(links.every((b) => / disabled/.test(b))).toBe(true);
    // A linked one isn't listed; no tick table.
    expect(h).not.toContain("east");
    expect(h).not.toContain('type="checkbox"');
    expect(h).not.toContain("hubla.linkTicked");
  });

  it("nothing unclear: the empty line", async () => {
    const h = await html([{ project: "east", hub: P("e1"), suggestion: null }]);
    expect(h).toContain('data-hubla-state="done"');
    expect(h).toContain("[ub.empty]");
    expect(h).not.toContain("<fieldset");
  });

  it("a clear one not linked yet: its own Link, below", async () => {
    const h = await html([
      { project: "north", hub: null, suggestion: P("n1", "repo") },
    ]);
    expect(h).toContain("[ub.empty]");
    expect(h).toMatch(
      /data-hubla-clear="north"[\s\S]*data-hubla-link="north"[^>]*data-hubla-hub="n1"/,
    );
  });
});
