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
} from "../../shared/hub/hub-project-sync.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import { projectRepos } from "../../shared/project-repos.js";
import { listRecords } from "../../shared/agents/records.js";
import { getStateDir } from "../../shared/paths.js";

let sync: ProjectSync | null = null;

export async function hubAndToken(): Promise<{
  url: string;
  token: string;
} | null> {
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
    spelling: projectRepos,
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

/**
 * Start it: one send now, then a cheap check on an interval. Issue 271:
 * the same beat reads a new Hub project asked of Hub (only when one
 * waits), so a project links on its own once an owner allows it.
 */
export async function retryDenUrlTellNow(): Promise<void> {
  try {
    const [{ retryDenUrlTell }, { readWebUrl }, hub] = await Promise.all([
      import("../../shared/hub/hub-den-url.js"),
      import("../../shared/web/web-url.js"),
      import("../../shared/hub.js"),
    ]);
    await retryDenUrlTell({
      hub: hubAndToken,
      put: hub.hubPutDenUrl,
      stateDir: getStateDir(),
      denUrl: () => readWebUrl()?.url ?? null,
    });
  } catch {
    return;
  }
}

export function startProjectSync(checkSeconds: number): void {
  const s = projectSync();
  s.request();
  const ms = Math.max(5, checkSeconds) * 1000;
  setInterval(() => {
    s.check();
    void retryDenUrlTellNow();
    void import("./hub-create-routes.js")
      .then((m) => m.settleAllHubCreates())
      .catch(() => undefined);
  }, ms).unref();
}

/**
 * 0.4.45: bring Hub's project names here (shared/hub-project-names.ts):
 * at start, after Connect, and every `hub.names_check_seconds` (default
 * 300). A page shows a new name on its next read of the projects.
 */
export async function refreshHubNamesNow(): Promise<string[]> {
  const at = await hubAndToken();
  if (!at) return [];
  const { refreshHubNames, recordHubNamesCheck } =
    await import("../../shared/hub/hub-project-names.js");
  const link = await import("../../shared/hub/hub-project-link.js");
  const hub = await import("../../shared/hub.js");
  return refreshHubNames({
    linked: () => {
      const out: [
        string,
        import("../../shared/hub/hub-project-link.js").HubProjectLink,
      ][] = [];
      for (const ws of Object.keys(readWorkspacesFile().workspaces)) {
        const l = link.hubProjectOf(ws);
        if (l) out.push([ws, l]);
      }
      return out;
    },
    hubProjects: async () => {
      const first = Object.keys(readWorkspacesFile().workspaces)[0] ?? "";
      const c = await hub.hubProjectChoices(at.url, at.token, {
        workspace: first,
        repos: [],
      });
      return c?.projects ?? null;
    },
    write: (ws, l) => link.setHubProject(ws, l, "Hub (its project's name)"),
    // Issue 167: the Name row says when Hub last answered.
    checked: (ok) => recordHubNamesCheck(getStateDir(), ok),
    // Issue 167: a rename asked of Hub ends when Hub has that name.
    named: (ws, name) => {
      if (link.hubRenameOf(ws)?.to === name)
        link.setHubRename(ws, null, "Hub (the rename was approved)");
    },
  });
}

/** Start it: now, then every `seconds`. */
export function startHubNameRefresh(seconds: number): void {
  const run = () => void refreshHubNamesNow().catch(() => undefined);
  run();
  setInterval(run, Math.max(5, seconds) * 1000).unref();
}

/**
 * 0.4.46: agents that started while Hub didn't answer get its tools back
 * with no person (ui/cli/mcp-reconnect.ts): every `seconds`, once Hub
 * answers Den again, each is restarted after its turn.
 */
export function startMcpReconnect(
  seconds: number,
  attempts: () => number,
): void {
  let rc: import("../cli/mcp-reconnect.js").McpReconnect | null = null;
  let busy = false;
  // Issue 629: a note held before Den restarted waits no more.
  void (async () => {
    try {
      const { notificationDeps } = await import("./notification-service.js");
      const u = await import("./update-check.js");
      u.clearToolsNotesHeld(notificationDeps().store);
    } catch {
      /* the bell is best effort */
    }
  })();
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!rc) {
        const m = await import("../cli/mcp-reconnect.js");
        const { webDeps } = await import("./agent-routes.js");
        const hub = await import("../../shared/hub.js");
        rc = m.mcpReconnect(webDeps(), {
          hubUp: async () => {
            const at = await hubAndToken();
            if (!at) return false;
            await hub.hubWhoami(at.url, at.token, { timeoutMs: 5000 });
            return true;
          },
          attempts,
          log: (line) => console.log(`[hub] ${line}`),
          // Issue 629: the note waits for the person's dialog: the bell says so.
          held: (id, ws) => void bellToolsNote(id, ws, true),
          cleared: (id) => void bellToolsNote(id, "", false),
          // Issue 749: its tool listing still fails after Den's one restart.
          gaveUp: (id, ws, error) => void bellToolsListFailed(id, ws, error),
          listed: (id) => void bellToolsListFailed(id, "", null),
        });
      }
      await rc.tick();
    } finally {
      busy = false;
    }
  };
  setInterval(
    () => void run().catch(() => undefined),
    Math.max(5, seconds) * 1000,
  ).unref();
}

/** Issue 629: the bell item for a tools note that waits, or its end. */
async function bellToolsNote(
  id: string,
  workspace: string,
  on: boolean,
): Promise<void> {
  try {
    const { notificationDeps } = await import("./notification-service.js");
    const u = await import("./update-check.js");
    const { product } = await import("../../shared/product.js");
    const store = notificationDeps().store;
    if (on) u.toolsNoteHeldNote(store, product().title, id, workspace);
    else
      store.remove((x) => x.subject === `${u.TOOLS_NOTE_HELD_SUBJECT}:${id}`);
  } catch {
    /* the bell is best effort */
  }
}

/** Issue 749: the bell item for an agent whose Hub tools still don't load, or its end. */
async function bellToolsListFailed(
  id: string,
  workspace: string,
  error: string | null,
): Promise<void> {
  try {
    const { notificationDeps } = await import("./notification-service.js");
    const u = await import("./update-check.js");
    const { product } = await import("../../shared/product.js");
    const store = notificationDeps().store;
    if (error !== null)
      u.toolsListFailedNote(store, product().title, id, workspace, error);
    else
      store.remove((x) => x.subject === `${u.TOOLS_LIST_FAILED_SUBJECT}:${id}`);
  } catch {
    /* the bell is best effort */
  }
}

/** How much of each org Den Hub can read, live (shared/hub/hub-github.ts). */
export { githubCoverage } from "../../shared/hub/hub-github.js";
