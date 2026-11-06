/**
 * `up -w <ws>` with no repo, no `-a` and no service repo under the cwd
 * (0.2.8-dev.1). `-w` only picks the workspace; it does not say what in it
 * to start, so the plan used to come back "No services specified and no
 * invocation target resolvable". It is a usage error naming the two forms
 * that do: a repo, or `-a` for the whole workspace.
 */
export function upNeedsTarget(cli: string, ws: string, plan: boolean): string {
  const name = /^[A-Za-z0-9._-]{1,64}$/.test(ws) ? ws : "<workspace>";
  const p = plan ? " --plan" : "";
  return (
    `up -w ${name} needs what to start: \`${cli} up -a${p} -w ${name}\` ` +
    `for the whole workspace, or \`${cli} up <repo>${p} -w ${name}\` for one repo and its dependencies.`
  );
}
