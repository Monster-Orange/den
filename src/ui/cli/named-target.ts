/**
 * Whether `address` ("repo" or "repo/service") is something the user named on
 * the command line: the address itself, or the repo it belongs to.
 */
export function isNamedTarget(
  address: string,
  named: readonly string[],
): boolean {
  const repo = address.split("/")[0];
  return named.some((n) => n === address || n === repo);
}
