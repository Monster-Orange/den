/**
 * The held writes' own logic (held-actions.ts), with fake deps: the
 * server agent's workspace_create makes the workspace active, and
 * service_try on an inactive workspace says it activates it and does, on
 * the one Allow. Nothing an agent calls activates a workspace otherwise.
 */
import { describe, expect, it } from "@jest/globals";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";

function fakes(): {
  deps: HeldActionDeps;
  made: Set<string>;
  active: Set<string>;
  tried: string[];
} {
  const made = new Set<string>(["default", "repos"]);
  const active = new Set<string>(["default"]);
  const tried: string[] = [];
  const deps: HeldActionDeps = {
    rules: () => ({ home: "/home/x" }) as never,
    validate: () => ({ ok: true }) as never,
    workspaceCreateRefusal: () => null,
    createWorkspace: (n) => void made.add(n),
    activateWorkspace: (n) => void active.add(n),
    workspaceActive: (n) => active.has(n),
    workspaceExists: (n) => made.has(n),
    defaultWorkspace: () => "default",
    serviceTarget: (s) => ({ ok: true, address: s }),
    tryService: async (address, ws) => {
      tried.push(
        `${address}@${ws ?? ""}:${ws && active.has(ws) ? "active" : "inactive"}`,
      );
      return { ok: true, exitCode: null, ready: true, lines: [] };
    },
  };
  return { deps, made, active, tried };
}

describe("held actions activate the workspace they need", () => {
  it("workspace_create's run creates the workspace and makes it active", async () => {
    const f = fakes();
    const a = heldActions(f.deps).workspace_create;
    const c = await a.check({ name: "web" });
    expect(c.ok).toBe(true);
    const r = await a.run({ name: "web" });
    expect(f.made.has("web")).toBe(true);
    expect(f.active.has("web")).toBe(true);
    expect(r).toEqual({ ok: true, name: "web", active: true });
  });

  it("service_try on an inactive workspace: the Review says it activates it, and the Allow does both", async () => {
    const f = fakes();
    const a = heldActions(f.deps).service_try;
    const c = await a.check({ service: "shop", workspace: "repos" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(
      'start shop in workspace "repos" (this activates repos)',
    );
    expect(c.params).toEqual({
      service: "shop",
      workspace: "repos",
      activates: "1",
    });
    await a.run(c.args);
    expect(f.tried).toEqual(["shop@repos:active"]);
  });

  it("service_try on an active workspace says nothing about activating", async () => {
    const f = fakes();
    const c = await heldActions(f.deps).service_try.check({
      service: "shop",
      workspace: "default",
    });
    expect(c.ok && c.summary).toBe('start shop in workspace "default"');
  });

  it("service_try on a workspace that doesn't exist is refused before anything waits", async () => {
    const f = fakes();
    const c = await heldActions(f.deps).service_try.check({
      service: "shop",
      workspace: "nope",
    });
    expect(c).toEqual({ ok: false, error: 'there is no workspace "nope"' });
  });
});
