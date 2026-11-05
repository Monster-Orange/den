/**
 * What `<cli> workspace deactivate` says about what it leaves running: it
 * releases only the daemons Den tracks, so a compose stack started from one
 * of the workspace's repos keeps running until `<cli> down <repo>`. A stack
 * another active workspace still holds is named as in use, never with a
 * command that would stop it.
 */
import type { WorkspaceStack } from "../../shared/stacks/status.js";

/**
 * The note for `stacks`: the running ones (null when docker could not be
 * asked, so it is said generically), or nothing when none is running.
 * `heldBy` maps a Compose project to the other active workspaces that hold
 * it.
 */
export function composeStacksNotice(
  cli: string,
  stacks: WorkspaceStack[] | null,
  heldBy: ReadonlyMap<string, string[]> = new Map(),
): string | null {
  if (stacks === null)
    return `compose stacks keep running: stop them with \`${cli} down <repo>\``;
  if (stacks.length === 0) return null;
  const held = stacks.filter((s) => heldBy.get(s.project)?.length);
  // `down <repo>` stops all of a repo's stacks: never suggest it for a repo
  // with a stack still in use.
  const heldRepos = new Set(held.map((s) => s.repo));
  const free = stacks.filter((s) => !heldRepos.has(s.repo));
  const inUse = held.map(
    (s) => `${s.project} (still in ${heldBy.get(s.project)!.join(", ")})`,
  );
  const parts: string[] = [];
  if (free.length) {
    const repos = [...new Set(free.map((s) => s.repo))];
    parts.push(
      `compose stacks keep running (${free.map((s) => s.project).join(", ")}): ` +
        `stop them with ${repos.map((r) => `\`${cli} down ${r}\``).join(", ")}`,
    );
  }
  if (inUse.length)
    parts.push(`in use by another workspace: ${inUse.join(", ")}`);
  return parts.join("; ");
}
