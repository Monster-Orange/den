/**
 * Issue 101: the persona roles that lead a project's agents. Den's ask
 * routing (src/ui/server/lead-routing.ts) sends a project's questions to
 * its lead, and the Coach (issue 113) reports messages from another
 * project that went around it. One list, so the two never disagree.
 */
export const LEAD_ROLES: readonly string[] = Object.freeze([
  "lead",
  "orchestrator",
]);
