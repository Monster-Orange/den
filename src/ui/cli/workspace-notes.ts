/**
 * What `<cli> workspace deactivate` says about what it leaves running: it
 * releases only the daemons Den tracks, so a compose stack started from one
 * of the workspace's repos keeps running until `<cli> down <repo>`.
 */
import type { WorkspaceStack } from "../../shared/stacks/status.js";

/**
 * The note for `stacks`: the running ones (null when docker could not be
 * asked, so it is said generically), or nothing when none is running.
 */
export function composeStacksNotice(
  cli: string,
  stacks: WorkspaceStack[] | null,
): string | null {
  if (stacks === null)
    return `compose stacks keep running: stop them with \`${cli} down <repo>\``;
  if (stacks.length === 0) return null;
  const repos = [...new Set(stacks.map((s) => s.repo))];
  return (
    `compose stacks keep running (${stacks.map((s) => s.project).join(", ")}): ` +
    `stop them with ${repos.map((r) => `\`${cli} down ${r}\``).join(", ")}`
  );
}
