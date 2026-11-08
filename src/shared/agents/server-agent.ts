/**
 * The server agent (ON-6): the Den server's own agent, named after the
 * distribution ("<Product> agent"). It belongs to no workspace. It runs
 * under a reserved scope, `den-server`, so it is a normal Den agent
 * underneath (records, sessions, resume, rotation, hooks) while its MCP
 * server sees the whole Den. It acts only through Den's MCP actions, and
 * each write is held for the person's Allow (ON-3).
 *
 * No workspace may take the reserved name: `workspace create` and the
 * MCP's workspace_create refuse it.
 */
import * as fs from "fs";
import * as path from "path";
import { enginePath } from "../engine.js";

/** The reserved scope the server agent's records and session live in. */
export const SERVER_SCOPE = "den-server";

/** The server agent's id, and its persona's. */
export const SERVER_AGENT_ID = "server";
export const SERVER_PERSONA_ID = "server";

/** Den's own pack for it, shipped in the package (src/ ships whole). */
export const SERVER_PACK_DIR = enginePath(
  "src",
  "shared",
  "agents",
  "server-pack",
);

/** Whether `ws` is the server agent's scope (never a workspace). */
export function isServerScope(ws: unknown): boolean {
  return ws === SERVER_SCOPE;
}

/**
 * The server agent's folder under the state dir: an empty folder it
 * starts in, so it has no checkout to edit and acts through Den's MCP.
 * Made when asked for.
 */
export function serverAgentDir(stateDir: string): string {
  const dir = path.join(stateDir, "server-agent");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Its name: the distribution's, then "agent" ("Acme agent"). */
export function serverAgentName(title: string): string {
  return `${title} agent`;
}

/** The refusal for a workspace that would take the reserved name. */
export function reservedWorkspaceError(ws: string): string | null {
  return isServerScope(ws)
    ? `"${ws}" is reserved for the server agent; pick another workspace name`
    : null;
}
