import { readAgentsConfig } from "../den-config.js";
import {
  readWorkspacesFile,
  writeWorkspacesFile,
} from "../environment-manager/workspaces.js";
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

export function projectCapValueError(
  ws: string,
  v: unknown,
  install: number = readAgentsConfig().maxPerProject,
): string | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    return `${projectCapKey(ws)}: must be a whole number, 0 or more (0: the install's) (got ${JSON.stringify(v)})`;
  if (install > 0 && v > install)
    return `${projectCapKey(ws)}: a project can only lower the install's cap, and ${INSTALL_KEY} is ${install} (got ${v})`;
  return null;
}

export function setProjectCap(ws: string, max: number | null): void {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const agents = { ...(cfg.agents ?? {}) };
  if (max === null) delete agents.max_per_project;
  else agents.max_per_project = max;
  const next = { ...cfg };
  if (Object.keys(agents).length) next.agents = agents;
  else delete next.agents;
  file.workspaces[ws] = next;
  writeWorkspacesFile(file);
}

export function ownProjectCap(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): number | null {
  const v = read().workspaces[ws]?.agents?.max_per_project;
  return typeof v === "number" ? v : null;
}
