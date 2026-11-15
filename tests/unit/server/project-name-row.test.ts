/**
 * 0.4.45 project names v5: Settings › Project setup › Name. Linked to Hub:
 * Hub's name, read-only, marked "Named in Hub" in words (not colour). Not
 * linked: an input and Save name, off until the name changed and is not
 * empty; an empty name says so. 1 to 60 characters, trimmed.
 */
import { describe, expect, it } from "@jest/globals";
import {
  hubProjectHtml,
  projectNameHtml,
  projectNameCheck,
  projectOrderHtml,
  DEN_SETTINGS as SETTINGS,
} from "../../../src/ui/server/public/settings-registry.js";

const t = (k: string, v?: Record<string, string>) =>
  k + (v ? JSON.stringify(v) : "");

describe("the Name row", () => {
  it("is in Project setup, per project", () => {
    const row = SETTINGS.find((s: { id: string }) => s.id === "workspace.name");
    expect(row).toMatchObject({ category: "workspace", scope: "workspace" });
  });

  it("linked: Hub's name, read-only, with the words Named in Hub", () => {
    const h = projectNameHtml(
      {
        slug: "north",
        cfg: {
          name: "north (local)",
          hub_project: { id: "p1", slug: "north-star", name: "North Star" },
        },
      },
      t,
    );
    expect(h).toContain('data-pname-state="hub"');
    expect(h).toContain("North Star");
    expect(h).not.toContain("north (local)");
    expect(h).toContain("pname.hubChip");
    expect(h).toContain("pname.hubHelp");
    expect(h).not.toMatch(/<input/);
  });

  it("not linked: an input with its own name, Save name off until changed", () => {
    const h = projectNameHtml({ slug: "beta", cfg: { name: "Écrin" } }, t);
    expect(h).toContain('data-pname-state="local"');
    expect(h).toMatch(/<input[^>]+value="Écrin"[^>]+maxlength="60"/);
    expect(h).toMatch(/<button[^>]+data-pname-save[^>]+disabled/);
    expect(h).toContain("pname.localHelp");
  });

  it("no name yet: the slug is the value", () => {
    expect(projectNameHtml({ slug: "alpha", cfg: {} }, t)).toMatch(
      /value="alpha"/,
    );
  });

  it("checks a new name: trimmed, not empty, at most 60, changed", () => {
    expect(projectNameCheck("  ", "a")).toEqual({ ok: false, why: "empty" });
    expect(projectNameCheck("x".repeat(61), "a")).toEqual({
      ok: false,
      why: "long",
    });
    expect(projectNameCheck(" a ", "a")).toEqual({ ok: false, why: "same" });
    expect(projectNameCheck(" North ", "a")).toEqual({
      ok: true,
      name: "North",
    });
  });
});

describe("Navigation › Project order", () => {
  it("names its key, says the state, and offers Reset only for a saved order", () => {
    const row = SETTINGS.find(
      (s: { id: string }) => s.id === "shell.projectOrder",
    );
    expect(row?.keys).toEqual(["shell.projectOrder"]);
    expect(projectOrderHtml(false, t)).toContain("ws.order.az");
    expect(projectOrderHtml(false, t)).not.toContain("data-porder-reset");
    expect(projectOrderHtml(true, t)).toContain("ws.order.mine");
    expect(projectOrderHtml(true, t)).toContain("data-porder-reset");
  });
});

/**
 * Issue 167 (mock v6 A0): Settings › Project setup › Hub project. Linked:
 * the read-only pair, how it was linked, where the work goes, and the rare
 * changes (switch, unlink, the terminal command) behind More. Waiting for
 * a pick: a button to Unclear matches. Not linked: a select and Link. Not
 * connected: Connect.
 */
describe("the Hub project row (A0)", () => {
  const BACK = { id: "proj_back1", slug: "back-office", name: "Back office" };
  const BLOG = { id: "proj_blog2", slug: "blog", name: "Blog" };
  const nm = (p: { name: string }) => p.name;
  // Vars in brackets: nothing the row escapes.
  const t = (k: string, v?: Record<string, string>) =>
    k + (v ? `(${Object.values(v).join("|")})` : "");

  it("linked: the pair, how and where, read-only; switch and Unlink behind More", () => {
    const h = hubProjectHtml(
      {
        project: "north",
        connected: true,
        hub: BACK,
        suggestions: [],
        projects: [BACK, BLOG],
      },
      t,
      nm,
    );
    expect(h).toContain('data-hubp-state="linked"');
    expect(h).toMatch(/data-hubp-pair[\s\S]*north[\s\S]*↔[\s\S]*Back office/);
    expect(h).toContain("hubp.linkedWhen");
    expect(h).toContain("hubp.does(north|Back office)");
    // The rare changes sit in a closed More.
    const more = h.slice(h.indexOf("<details"));
    expect(h).toMatch(/<details[^>]*data-hubp-more(?![^>]*open)/);
    expect(more).toContain("hubp.more");
    expect(more).toContain("hubp.switchL");
    expect(more).toContain('data-hubp-action="link"');
    expect(more).toContain("hubp.switch");
    expect(more).toContain('data-hubp-action="unlink"');
    expect(more).toContain("hubp.cli");
    // The linked one isn't offered again.
    expect(more).not.toContain(`value="${BACK.id}"`);
    expect(more).toContain(`value="${BLOG.id}"`);
  });

  it("not linked: says Unfiled, a select with Hub's suggestion picked, Link", () => {
    const h = hubProjectHtml(
      {
        project: "north",
        connected: true,
        hub: null,
        suggestions: [{ ...BACK, why: "repo" }],
        projects: [BLOG, BACK],
      },
      t,
      nm,
    );
    expect(h).toContain('data-hubp-state="unlinked"');
    expect(h).toContain("hubp.notLinked(north)");
    expect(h).toContain("hubp.linkProject(north)");
    expect(h).toMatch(/<option value="proj_back1" selected>/);
    expect(h).toContain('data-hubp-action="link"');
    expect(h).toContain("hubp.scope(north)");
    expect(h).not.toContain("<details");
  });

  it("waiting for a pick: says nothing is filed, and opens Unclear matches", () => {
    const h = hubProjectHtml(
      {
        project: "north",
        connected: true,
        hub: null,
        pick: true,
        suggestions: [
          { ...BACK, why: "repo" },
          { ...BLOG, why: "repo" },
        ],
        projects: [BLOG, BACK],
      },
      t,
      nm,
    );
    expect(h).toContain('data-hubp-state="pick"');
    expect(h).toContain("hubp.waiting(north)");
    expect(h).toMatch(
      /<a[^>]+href="\/settings#agents\.hub_link_all"[^>]*>hubp\.pickBtn<\/a>/,
    );
    expect(h).not.toContain("<select");
  });

  it("not connected: says so, with Connect", () => {
    const h = hubProjectHtml({ project: "north", connected: false }, t, nm);
    expect(h).toContain('data-hubp-state="offline"');
    expect(h).toContain("hubp.noHub");
    expect(h).toMatch(
      /<a[^>]+class="btn sm primary"[^>]+href="\/settings#agents\.hub"[^>]*>hubp\.connectBtn<\/a>/,
    );
  });
});
