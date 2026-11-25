import * as path from "path";
import { readCatalog } from "./environment-manager/catalog.js";
import {
  listWorkspaceServices,
  readWorkspacesFile,
} from "./environment-manager/workspaces.js";

/** A project's repo folders, from its services; [] when unreadable. */
export function projectRepoDirsOf(name: string): string[] {
  try {
    const cfg = readWorkspacesFile().workspaces?.[name];
    if (!cfg) return [];
    return listWorkspaceServices(cfg, readCatalog(), name)
      .map((r) => r.repoPath)
      .filter((p) => !!p && path.isAbsolute(p));
  } catch {
    return [];
  }
}

/** Every project's repo folders, from its services; [] when unreadable. */
export function projectRepoDirs(): string[] {
  try {
    const cat = readCatalog();
    const wss = readWorkspacesFile().workspaces ?? {};
    return [
      ...new Set(
        Object.entries(wss).flatMap(([name, cfg]) =>
          listWorkspaceServices(cfg, cat, name)
            .map((r) => r.repoPath)
            .filter((p) => !!p && path.isAbsolute(p)),
        ),
      ),
    ];
  } catch {
    return [];
  }
}
