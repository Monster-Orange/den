/**
 * 0.4.45 project names v5: Settings › Project setup › Name. Linked to Hub:
 * Hub's name, read-only, marked "Named in Hub" in words (not colour). Not
 * linked: an input and Save name, off until the name changed and is not
 * empty; an empty name says so. 1 to 60 characters, trimmed.
 */
import { describe, expect, it } from "@jest/globals";
import {
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
