/**
 * A workspace's stack namespace (the Compose project suffix), first match
 * wins: `stack_namespace` in workspaces.yml, then the blueprint's, then the
 * workspace's own name (`default`: `main`). workspaces.yml overriding a
 * different blueprint value warns, naming both. A bad value is a config
 * error naming the key. The lists (`workspace list`, `/api/workspaces`) show
 * it resolved, with its source, and whether it differs from the default.
 *
 * Pure: every test builds its own context. Neutral names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  readBlueprintStackNamespaces,
  readWorkspaceBlueprints,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import {
  resolveStackNamespace,
  stackNamespaceRows,
  type StackNamespaceContext,
} from "../../../src/shared/stacks/namespace.js";
import type { WorkspaceConfig } from "../../../src/shared/types/index.js";

const ws = (over: Partial<WorkspaceConfig> = {}): WorkspaceConfig => ({
  services: {},
  ...over,
});
const ctx = (
  workspaces: Record<string, WorkspaceConfig>,
  blueprint: Record<string, string> = {},
): StackNamespaceContext => ({ file: { workspaces }, blueprint });
const config = (defaults: unknown): DenConfig =>
  ({ environments: ["local"], defaults }) as unknown as DenConfig;

describe("resolveStackNamespace: precedence", () => {
  it("no key anywhere: the workspace's own name, and default is main", () => {
    const c = ctx({ default: ws(), shop: ws() });
    expect(resolveStackNamespace("shop", c)).toEqual({
      workspace: "shop",
      namespace: "shop",
      source: "default",
      defaultNamespace: "shop",
      warnings: [],
    });
    expect(resolveStackNamespace("default", c)).toMatchObject({
      namespace: "main",
      source: "default",
      defaultNamespace: "main",
    });
  });

  it("the blueprint's stack_namespace beats the default", () => {
    const c = ctx({ shop: ws() }, { shop: "main" });
    expect(resolveStackNamespace("shop", c)).toMatchObject({
      namespace: "main",
      source: "blueprint",
      defaultNamespace: "shop",
      warnings: [],
    });
  });

  it("workspaces.yml beats the blueprint, and warns naming both values", () => {
    const c = ctx(
      { shop: ws({ stack_namespace: "shared" }) },
      { shop: "main" },
    );
    const r = resolveStackNamespace("shop", c);
    expect(r).toMatchObject({ namespace: "shared", source: "workspace" });
    expect(r.warnings).toEqual([
      "project shop: stack_namespace shared in workspaces.yml overrides the blueprint's stack_namespace main",
    ]);
  });

  it("workspaces.yml equal to the blueprint: no warning", () => {
    const c = ctx({ shop: ws({ stack_namespace: "main" }) }, { shop: "main" });
    expect(resolveStackNamespace("shop", c).warnings).toEqual([]);
  });
});

describe("validation", () => {
  it.each([["Main"], ["-main"], ["main-"], ["ma_in"], [""], [7]])(
    "workspaces.yml %p is a config error naming the key",
    (bad) => {
      const c = ctx({ shop: ws({ stack_namespace: bad as string }) });
      expect(() => resolveStackNamespace("shop", c)).toThrow(
        /^workspaces\.shop\.stack_namespace \(config\/local\/workspaces\.yml\) must be lowercase letters, digits and dashes/,
      );
    },
  );

  it("a bad blueprint value names defaults.workspaces.<n>.stack_namespace", () => {
    const cfg = config({
      workspaces: { shop: { repos: ["shop"], stack_namespace: "Shop" } },
    });
    expect(() => readBlueprintStackNamespaces(cfg)).toThrow(
      /^defaults\.workspaces\.shop\.stack_namespace must be lowercase letters, digits and dashes/,
    );
    expect(() => readWorkspaceBlueprints(cfg)).toThrow(
      /^defaults\.workspaces\.shop\.stack_namespace must be/,
    );
  });

  it("the blueprint carries stack_namespace beside org (an allowed key)", () => {
    const cfg = config({
      workspaces: {
        shop: { repos: ["shop"], org: "acme", stack_namespace: "main" },
        cart: { repos: ["cart"] },
      },
    });
    expect(readWorkspaceBlueprints(cfg).workspaces).toEqual([
      expect.objectContaining({
        name: "shop",
        org: "acme",
        stackNamespace: "main",
      }),
      expect.not.objectContaining({ stackNamespace: expect.anything() }),
    ]);
    expect(readBlueprintStackNamespaces(cfg)).toEqual({ shop: "main" });
  });

  it("the single defaults.workspace's namespace is default's", () => {
    const cfg = config({
      workspace: { repos: ["shop"], stack_namespace: "store" },
    });
    expect(readBlueprintStackNamespaces(cfg)).toEqual({ default: "store" });
  });

  it("reads the namespaces of a blueprint malformed elsewhere", () => {
    const cfg = config({
      workspaces: { shop: { repos: "not-a-list", stack_namespace: "main" } },
    });
    expect(() => readWorkspaceBlueprints(cfg)).toThrow(/repos/);
    expect(readBlueprintStackNamespaces(cfg)).toEqual({ shop: "main" });
  });
});

describe("stackNamespaceRows: what the list and the API show", () => {
  it("resolved, with its source and whether it differs; a bad one is its row's error", () => {
    const c = ctx(
      {
        default: ws(),
        shop: ws({ stack_namespace: "main" }),
        cart: ws(),
        main: ws({ stack_namespace: "main" }),
        bad: ws({ stack_namespace: "No" }),
      },
      { cart: "main" },
    );
    const rows = stackNamespaceRows(
      ["default", "shop", "cart", "main", "bad"],
      c,
    );
    expect(rows.map(({ error, ...r }) => ({ ...r, error: !!error }))).toEqual([
      {
        workspace: "default",
        stack_namespace: "main",
        source: "default",
        default: "main",
        differs: false,
        warnings: [],
        error: false,
      },
      {
        workspace: "shop",
        stack_namespace: "main",
        source: "workspace",
        default: "shop",
        differs: true,
        warnings: [],
        error: false,
      },
      {
        workspace: "cart",
        stack_namespace: "main",
        source: "blueprint",
        default: "cart",
        differs: true,
        warnings: [],
        error: false,
      },
      {
        workspace: "main",
        stack_namespace: "main",
        source: "workspace",
        default: "main",
        differs: false,
        warnings: [],
        error: false,
      },
      {
        workspace: "bad",
        stack_namespace: null,
        source: null,
        default: "bad",
        differs: false,
        warnings: [],
        error: true,
      },
    ]);
    expect(rows[4].error).toMatch(/workspaces\.bad\.stack_namespace/);
  });
});
