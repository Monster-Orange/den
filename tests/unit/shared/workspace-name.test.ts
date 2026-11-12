/**
 * D70: a workspace has a name (what the person typed) and a slug (derived;
 * the config key, paths, URLs, the CLI). Every entry point takes either,
 * and nothing is created that the next step refuses: "back office" made
 * through MCP, then repo_add to it by name and by slug, then the agents
 * CLI's check, all go through.
 */
import { describe, expect, it } from "@jest/globals";
import {
  migrateWorkspaceKeys,
  resolveWorkspaceKey,
  workspaceDisplayName,
  workspaceNameRefusal,
  workspaceSlug,
} from "../../../src/shared/workspace-name.js";
import { normalizeWorkspacesFileShape } from "../../../src/shared/environment-manager/workspaces.js";
import { workspaceUrl } from "../../../src/ui/server/workspace-url.js";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import { WORKSPACE_NAME_RE } from "../../../src/shared/agent-actor.js";

describe("the slug of a name", () => {
  it.each([
    ["back office", "back-office"],
    ["Jane Doe", "jane-doe"],
    ["team hub", "team-hub"],
    ["  summer   pics ", "summer-pics"],
    ["Café notes", "cafe-notes"],
    ["web", "web"],
    ["a.b_c-d", "a.b_c-d"],
  ])("%j → %j", (name, slug) => {
    expect(workspaceSlug(name)).toBe(slug);
    expect(WORKSPACE_NAME_RE.test(slug)).toBe(true);
  });
  it("no letter or digit: none", () => {
    expect(workspaceSlug("!!!")).toBeNull();
    expect(workspaceSlug("   ")).toBeNull();
  });
});

describe("one check before any create", () => {
  const have = { web: {}, "back-office": { name: "back office" } };
  it("a name with spaces is fine", () => {
    expect(workspaceNameRefusal("monster orange", have)).toBeNull();
  });
  it("taken by its slug or its name, in any case", () => {
    expect(workspaceNameRefusal("Back Office", have)).toMatch(
      /"back office" already exists/,
    );
    expect(workspaceNameRefusal("back-office", have)).toMatch(/already exists/);
    expect(workspaceNameRefusal("WEB", have)).toMatch(/already exists/);
  });
  it("refused: empty, no letter or digit, a slash or a quote", () => {
    expect(workspaceNameRefusal("", have)).toBe("name required");
    expect(workspaceNameRefusal("***", have)).toMatch(/letter or digit/);
    expect(workspaceNameRefusal("a/b", have)).toMatch(/slashes/);
  });
});

describe("either one names it", () => {
  const have = { web: {}, "back-office": { name: "back office" } };
  it.each([
    ["back office", "back-office"],
    ["Back Office", "back-office"],
    ["back-office", "back-office"],
    ["web", "web"],
    ["WEB", "web"],
  ])("%j → %j", (input, key) => {
    expect(resolveWorkspaceKey(input, have)).toBe(key);
  });
  it("none: undefined", () => {
    expect(resolveWorkspaceKey("nope", have)).toBeUndefined();
  });
  it("shows the name, else the slug", () => {
    expect(workspaceDisplayName("back-office", have["back-office"])).toBe(
      "back office",
    );
    expect(workspaceDisplayName("web", {})).toBe("web");
  });
});

describe("workspaces written before slugs move to them", () => {
  it("a key with spaces becomes its slug, the old key its name; active and focus follow", () => {
    const { file, changed } = normalizeWorkspacesFileShape({
      active: ["default", "jane doe"],
      focus: "jane doe",
      workspaces: {
        default: { services: {} },
        "jane doe": { services: {} },
        "team hub": { services: { hub: { mode: "dev-managed" } } as never },
      },
    });
    expect(changed).toBe(true);
    expect(Object.keys(file.workspaces).sort()).toEqual([
      "default",
      "jane-doe",
      "team-hub",
    ]);
    expect(file.workspaces["jane-doe"].name).toBe("jane doe");
    expect(file.workspaces["team-hub"].services).toEqual({
      hub: { mode: "dev-managed" },
    });
    expect(file.active).toEqual(["default", "jane-doe"]);
    expect(file.focus).toBe("jane-doe");
  });
  it("a slug already taken: the old key stays", () => {
    const { workspaces, moved } = migrateWorkspaceKeys({
      "back-office": {},
      "back office": {},
    });
    expect(moved.size).toBe(0);
    expect(Object.keys(workspaces).sort()).toEqual([
      "back office",
      "back-office",
    ]);
  });
});

describe("the API takes a name where it takes a workspace", () => {
  const all = () => ({ "jane-doe": { name: "jane doe" }, web: {} });
  it.each([
    ["/api/workspaces/jane%20doe/agents", "/api/workspaces/jane-doe/agents"],
    [
      "/api/workspaces/Jane%20Doe/agents/x/stop",
      "/api/workspaces/jane-doe/agents/x/stop",
    ],
    ["/api/sessions?ws=jane%20doe", "/api/sessions?ws=jane-doe"],
    ["/api/workspaces/web/agents", "/api/workspaces/web/agents"],
    ["/api/workspaces/create", "/api/workspaces/create"],
    ["/agents?x=1", "/agents?x=1"],
  ])("%s → %s", (from, to) => {
    expect(workspaceUrl(from, all)).toBe(to);
  });
});

describe('the gate: "back office" through MCP, then reach it by name and by slug', () => {
  it("creates it under its slug, active; service_try takes it by name or slug", async () => {
    const made: Record<string, { name?: string }> = { default: {} };
    const active = new Set(["default"]);
    const deps: HeldActionDeps = {
      rules: () => ({ home: "/home/x", roots: ["/home/x"] }) as never,
      validate: () => ({ ok: true }) as never,
      workspaceCreateRefusal: (n) => workspaceNameRefusal(n, made),
      createWorkspace: (n) => {
        const slug = workspaceSlug(n)!;
        made[slug] = n.trim() === slug ? {} : { name: n.trim() };
        return slug;
      },
      resolveWorkspace: (i) => resolveWorkspaceKey(i, made) ?? i,
      activateWorkspace: (n) => void active.add(n),
      workspaceActive: (n) => active.has(n),
      workspaceExists: (n) => n in made,
      defaultWorkspace: () => "default",
      serviceTarget: (s) => ({ ok: true, address: s }),
      tryService: async () => ({
        ok: true,
        exitCode: null,
        ready: true,
        lines: [],
      }),
    };
    const h = heldActions(deps);
    expect((await h.workspace_create.check({ name: "back office" })).ok).toBe(
      true,
    );
    const r = await h.workspace_create.run({ name: "back office" });
    expect(r).toMatchObject({
      ok: true,
      name: "back office",
      slug: "back-office",
    });
    expect(made["back-office"]).toEqual({ name: "back office" });
    expect(active.has("back-office")).toBe(true);
    // service_try's check takes the workspace by name and by slug alike.
    for (const ws of ["back office", "back-office", "Back Office"]) {
      const c = await h.service_try.check({ service: "shop", workspace: ws });
      expect(c.ok).toBe(true);
    }
  });
});
