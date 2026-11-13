/**
 * A project's repos as owner/repo (HUB-1.5's X-Den-Repos; H5's Hub
 * suggestions): its services' catalog entries, each repo once. [] when the
 * project is gone or a file can't be read.
 */
import { readCatalog } from "./environment-manager/catalog.js";
import {
  listWorkspaceServices,
  readWorkspacesFile,
} from "./environment-manager/workspaces.js";
import { ownerRepo } from "./hub.js";

export function projectRepos(name: string): string[] {
  try {
    const cfg = readWorkspacesFile().workspaces[name];
    if (!cfg) return [];
    const cat = readCatalog();
    const out: string[] = [];
    for (const r of listWorkspaceServices(cfg, cat, name)) {
      const slug = ownerRepo(cat[r.repoName]);
      if (slug && !out.includes(slug)) out.push(slug);
    }
    return out;
  } catch {
    return [];
  }
}
