/**
 * #57: an agent whose record names a project by a key written before D70
 * ("den hub") follows the project to its slug ("den-hub"). The project was
 * renamed, not deleted: its key moved (workspace-name.ts
 * migrateWorkspaceKeys), and the old key is kept as its name, so the old
 * key still resolves. Each such record is rewritten once: `workspace`, and
 * `project` when it named the same old key. Its session and folder stay.
 *
 * A record whose project resolves to nothing is left alone: that project
 * really is gone (D71 lists it so it can be moved).
 */
import { resolveWorkspaceKey } from "../workspace-name.js";
import { listRecords, writeRecord } from "./records.js";

export function healRecordWorkspaces(
  stateDir: string,
  workspaces: Record<string, { name?: unknown }>,
  isServerScope: (ws: string) => boolean = () => false,
): string[] {
  const healed: string[] = [];
  for (const rec of listRecords(stateDir)) {
    const ws = rec.workspace;
    if (typeof ws !== "string" || !ws || isServerScope(ws)) continue;
    if (Object.prototype.hasOwnProperty.call(workspaces, ws)) continue;
    const key = resolveWorkspaceKey(ws, workspaces);
    if (!key || key === ws) continue;
    const next = { ...rec, workspace: key };
    if (rec.project === ws) next.project = key;
    try {
      writeRecord(stateDir, next);
      healed.push(rec.id);
    } catch {
      /* unwritable: tried again on the next list */
    }
  }
  return healed;
}
