/**
 * The one check for a GitHub repo, `owner/name`, wherever Den
 * takes one. It matches what GitHub allows. A "." or ".." segment is
 * refused: a URL parser folds it into another path, so a call would go
 * somewhere the code never meant.
 *
 * - owner: 1 to 39 letters, digits, "-" or "_" (an enterprise-managed
 *   user's "_shortcode"), never starting with "-" or "_"; no dots
 * - name: 1 to 100 letters, digits, ".", "-" or "_", never "." or "..",
 *   never starting with "-" (".github" is fine)
 */
export const REPO_OWNER_MAX = 39;
export const REPO_NAME_MAX = 100;

export const REPO_NAME_RE = new RegExp(
  `^([A-Za-z0-9][A-Za-z0-9_-]{0,${REPO_OWNER_MAX - 1}})` +
    `/((?!\\.{1,2}$)(?!-)[A-Za-z0-9._-]{1,${REPO_NAME_MAX}})$`,
);

/** The owner and name of a GitHub repo, or null when it isn't one. */
export function parseRepoName(
  v: unknown,
): { owner: string; name: string } | null {
  if (typeof v !== "string") return null;
  const m = REPO_NAME_RE.exec(v);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** Whether `v` is a GitHub repo, owner/name (see the header). */
export function isRepoName(v: unknown): v is string {
  return parseRepoName(v) !== null;
}
