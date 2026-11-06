/**
 * A workspace's stack namespace: the suffix its stacks' Compose projects run
 * under (`<stack>-<namespace>`), and so the names of their containers,
 * volumes and networks.
 *
 * By default it is the workspace's own name (`default`: `main`, see
 * stackWorkspace). A workspace can set `stack_namespace` to opt out: several
 * workspaces may then share one namespace, and a stack keeps its data when
 * its repo moves between workspaces. First match wins:
 *
 *   1. `stack_namespace:` on the workspace in workspaces.yml (per machine)
 *   2. `stack_namespace:` on the same-named blueprint workspace
 *   3. stackWorkspace(name)
 *
 * Every stack code path turns a den workspace into its suffix through
 * resolveStackWorkspaces (status.ts), which calls this; DEN_STACK_WORKSPACE
 * still wins there, for one process.
 */
import {
  checkStackNamespace,
  readBlueprintStackNamespaces,
  readDenConfig,
  type DenConfig,
} from "../den-config.js";
import { readWorkspacesFile } from "../environment-manager/workspaces.js";
import { cachedRead } from "../read-cache.js";
import type { WorkspacesFile } from "../types/index.js";
import { stackWorkspace } from "./render.js";

/** Which step gave the namespace. */
export type StackNamespaceSource = "workspace" | "blueprint" | "default";

export interface StackNamespace {
  workspace: string;
  /** The Compose project suffix. */
  namespace: string;
  source: StackNamespaceSource;
  /** What it would be with no `stack_namespace` anywhere. */
  defaultNamespace: string;
  /** workspaces.yml overriding a different blueprint value, as a sentence. */
  warnings: string[];
}

export interface StackNamespaceContext {
  file: Pick<WorkspacesFile, "workspaces">;
  /** Blueprint `stack_namespace` by workspace name. */
  blueprint: Record<string, string>;
}

/**
 * workspaces.yml and the blueprint's namespaces, as they are now. A
 * workspaces file that cannot be read sets no namespace (its other readers
 * report it), and so does an unreadable org config; a bad
 * `stack_namespace` value still throws.
 */
export function readStackNamespaceContext(): StackNamespaceContext {
  return cachedRead("stack-namespace-context", () => {
    let file: StackNamespaceContext["file"] = { workspaces: {} };
    try {
      file = readWorkspacesFile() ?? file;
    } catch {
      /* unreadable: no workspace sets one */
    }
    let config: DenConfig | null = null;
    try {
      config = readDenConfig();
    } catch {
      /* unreadable: no blueprint sets one */
    }
    return {
      file,
      blueprint: config ? readBlueprintStackNamespaces(config) : {},
    };
  });
}

/**
 * Resolve one workspace's stack namespace. A malformed `stack_namespace`
 * (workspaces.yml or blueprint) throws, naming the key: falling back to
 * another name would run the stacks against other volumes.
 */
export function resolveStackNamespace(
  name: string,
  ctx: StackNamespaceContext = readStackNamespaceContext(),
): StackNamespace {
  const defaultNamespace = stackWorkspace(name);
  const own = checkStackNamespace(
    `workspaces.${name}.stack_namespace (config/local/workspaces.yml)`,
    ctx.file.workspaces?.[name]?.stack_namespace,
  );
  const bp = ctx.blueprint[name];
  const warnings: string[] = [];
  if (own) {
    if (bp && bp !== own)
      warnings.push(
        `workspace ${name}: stack_namespace ${own} in workspaces.yml overrides the blueprint's stack_namespace ${bp}`,
      );
    return {
      workspace: name,
      namespace: own,
      source: "workspace",
      defaultNamespace,
      warnings,
    };
  }
  if (bp)
    return {
      workspace: name,
      namespace: bp,
      source: "blueprint",
      defaultNamespace,
      warnings,
    };
  return {
    workspace: name,
    namespace: defaultNamespace,
    source: "default",
    defaultNamespace,
    warnings,
  };
}

/** One workspace's namespace as the lists show it: resolved, or the error. */
export interface StackNamespaceRow {
  workspace: string;
  /** The resolved namespace; null when its config is invalid. */
  stack_namespace: string | null;
  source: StackNamespaceSource | null;
  /** The suffix with no `stack_namespace` anywhere. */
  default: string;
  /** True when the namespace is not the default suffix. */
  differs: boolean;
  warnings: string[];
  error?: string;
}

/**
 * Every named workspace's stack namespace, for `workspace list` and
 * `/api/workspaces`. A bad value is that row's error, never the list's.
 */
export function stackNamespaceRows(
  names: string[],
  ctx?: StackNamespaceContext,
): StackNamespaceRow[] {
  let c: StackNamespaceContext | null = ctx ?? null;
  let ctxError: string | null = null;
  if (!c)
    try {
      c = readStackNamespaceContext();
    } catch (e) {
      ctxError = (e as Error).message;
    }
  return names.map((workspace) => {
    const fallback = stackWorkspace(workspace);
    try {
      if (!c) throw new Error(ctxError ?? "unreadable");
      const ns = resolveStackNamespace(workspace, c);
      return {
        workspace,
        stack_namespace: ns.namespace,
        source: ns.source,
        default: ns.defaultNamespace,
        differs: ns.namespace !== ns.defaultNamespace,
        warnings: ns.warnings,
      };
    } catch (e) {
      return {
        workspace,
        stack_namespace: null,
        source: null,
        default: fallback,
        differs: false,
        warnings: [],
        error: (e as Error).message,
      };
    }
  });
}
