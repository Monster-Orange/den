/**
 * H5 project sync, as this server runs it: one ProjectSync, sent at start
 * and on connect (request), and checked every `hub.sync_check_seconds`
 * (default 30) for a changed project list (check: a local read, no call
 * when nothing changed). GitHub App coverage is asked live, on demand.
 */
import {
  ProjectSync,
  projectList,
  syncAgents,
} from "../../shared/hub-project-sync.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import { projectRepos } from "../../shared/project-repos.js";
import { listRecords } from "../../shared/agents/records.js";
import { getStateDir } from "../../shared/paths.js";

let sync: ProjectSync | null = null;

async function hubAndToken(): Promise<{ url: string; token: string } | null> {
  const hub = await import("../../shared/hub.js");
  const cfg = hub.readHubConfig();
  if (!cfg) return null;
  const token = await hub.readHubToken(cfg);
  return token ? { url: cfg.url, token } : null;
}

export function projectSync(): ProjectSync {
  return (sync ??= new ProjectSync({
    list: () => {
      const agents = syncAgents(listRecords(getStateDir()));
      return projectList(
        readWorkspacesFile(),
        projectRepos,
        (ws) => agents.get(ws) ?? [],
      );
    },
    send: async (projects) => {
      const at = await hubAndToken();
      if (!at) return null;
      const hub = await import("../../shared/hub.js");
      return hub.hubPutProjects(at.url, at.token, {
        projects,
        sent_at: new Date().toISOString(),
      });
    },
  }));
}

/** Start it: one send now, then a cheap check on an interval. */
export function startProjectSync(checkSeconds: number): void {
  const s = projectSync();
  s.request();
  const ms = Math.max(5, checkSeconds) * 1000;
  setInterval(() => s.check(), ms).unref();
}

/** How much of each org Den Hub can read, live (shared/hub-github.ts). */
export { githubCoverage } from "../../shared/hub-github.js";
