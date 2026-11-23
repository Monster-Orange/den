/**
 * Issue 476: pure ties between the reviewer and the rest of Den, used by
 * the server's review service (review-mesh-service.ts).
 */
import { ownerRepo } from "../../hub.js";

export interface AgentHere {
  id: string;
  cwd: string;
  running: boolean;
  /** A review leg's own session: never an author. */
  leg?: boolean;
}

/**
 * The agent on this install that authored a PR: the one running agent
 * whose folder is on the PR's head branch. None, or more than one: null,
 * and the hand-back goes to the person.
 */
export function authorAgentFor(
  headRef: string,
  agents: readonly AgentHere[],
  branchOf: (cwd: string) => string | null,
): string | null {
  if (!headRef) return null;
  const hits = agents.filter(
    (a) => a.running && !a.leg && branchOf(a.cwd) === headRef,
  );
  return hits.length === 1 ? hits[0].id : null;
}

/** The catalog repo name whose GitHub slug is `slug` (owner/name). */
export function catalogRepoFor(
  catalog: Record<string, { gh?: string; remote?: string } | undefined>,
  slug: string,
): string | null {
  for (const [name, entry] of Object.entries(catalog))
    if (ownerRepo(entry) === slug) return name;
  return null;
}
