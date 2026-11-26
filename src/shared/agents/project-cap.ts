import { readAgentsConfig } from "../den-config.js";
import { readWorkspacesFile } from "../environment-manager/workspaces.js";
import type { WorkspacesFile } from "../types/index.js";

export const INSTALL_KEY = "agents.max_per_project";
export const projectCapKey = (ws: string) =>
  `workspaces.${ws}.agents.max_per_project`;

export function projectAgentCap(
  ws: string,
  install: number = readAgentsConfig().maxPerProject,
  read: () => WorkspacesFile = readWorkspacesFile,
): { limit: number; key: string } {
  let own: unknown;
  try {
    own = read().workspaces[ws]?.agents?.max_per_project;
  } catch {
    own = undefined;
  }
  if (own === undefined || own === null)
    return { limit: install, key: INSTALL_KEY };
  if (typeof own !== "number" || !Number.isInteger(own) || own < 0)
    throw new Error(
      `${projectCapKey(ws)}: must be a whole number, 0 or more (0: the install's) (got ${JSON.stringify(own)})`,
    );
  if (own === 0 || (install > 0 && own > install))
    return { limit: install, key: INSTALL_KEY };
  return { limit: own, key: projectCapKey(ws) };
}
