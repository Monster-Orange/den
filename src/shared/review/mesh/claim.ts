/**
 * Issue 476 (REVIEW-MESH-SPEC RV-9 item 1): claiming a PR through its own
 * thread, with no shared database. Each reviewer posts an "in queue"
 * status comment carrying a hidden marker, waits the claim window, then
 * rereads the thread. The lowest comment id among live claims for this
 * head wins (GitHub ids only go up). The winner edits its comment to
 * "started"; the others delete theirs. A reviewer that can't read the
 * thread goes ahead: a duplicate review beats none.
 */
export interface ClaimWho {
  /** The head commit the claim is for. */
  sha: string;
  /** The install. */
  inst: string;
  agent: string;
  /** The GitHub login the agent works for. */
  for: string;
}

export interface Claim extends ClaimWho {
  /** The comment's id. */
  id: number;
  /** When the comment was made (ms since the epoch). */
  createdAt: number;
}

const VALUE_RE = /^[A-Za-z0-9_.:/[\]-]{1,128}$/;

/** The hidden marker a claim comment carries. */
export function claimMarker(w: ClaimWho): string {
  for (const [k, v] of Object.entries(w))
    if (!VALUE_RE.test(v)) throw new Error(`claim ${k} can't go in a marker`);
  return `<!-- den-review-claim v=1 sha=${w.sha} inst=${w.inst} agent=${w.agent} for=${w.for} -->`;
}

const MARKER_RE =
  /<!-- den-review-claim v=1 sha=(\S+) inst=(\S+) agent=(\S+) for=(\S+) -->/;

/** The claims among a thread's comments, in the thread's order. */
export function parseClaims(
  comments: readonly { id: number; body: string; createdAt: number }[],
): Claim[] {
  const out: Claim[] = [];
  for (const c of comments) {
    const m = MARKER_RE.exec(c.body);
    if (!m) continue;
    out.push({
      id: c.id,
      createdAt: c.createdAt,
      sha: m[1],
      inst: m[2],
      agent: m[3],
      for: m[4],
    });
  }
  return out;
}

/**
 * Who holds the review of head `sha`: the lowest comment id among claims
 * for it made within `timeoutMs` of `now`. Null when nobody does.
 */
export function claimWinner(
  claims: readonly Claim[],
  sha: string,
  now: number,
  timeoutMs: number,
): Claim | null {
  let best: Claim | null = null;
  for (const c of claims) {
    if (c.sha !== sha || now - c.createdAt > timeoutMs) continue;
    if (!best || c.id < best.id) best = c;
  }
  return best;
}
