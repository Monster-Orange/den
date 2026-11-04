/**
 * Types for the derived dependency graph (`den graph` / derived `den up`).
 *
 * The graph is derived from real signals in each repo (SDK imports, service
 * URLs, IaC stack refs, EventBridge rules) rather than trusting each repo's
 * hand-written `.den.yml` `depends_on`. See derive-graph.ts for the engine.
 */

/**
 * What kind of dependency an edge represents — this drives whether `den up`
 * orders on it:
 *   infra — shared local infra (infra-stack / LocalStack). Hard foundation.
 *   http  — synchronous HTTP call to a peer service.
 *   jwks  — peer's JWKS endpoint used for JWT verification (a kind of http).
 *   event — EventBridge producer→consumer data-flow. Shown, never ordered.
 */
export type EdgeKind = "infra" | "http" | "jwks" | "event";

/**
 * Whether the edge constrains startup order:
 *   hard — `from`'s `make up` fails / `from` is non-functional unless `to` is up first.
 *   soft — started as part of the dev stack but does not constrain order.
 */
export type EdgeBlocking = "hard" | "soft";

export type Confidence = "high" | "medium" | "low";

export interface DerivedEdge {
  /** Source repo-system name (catalog/repo key). */
  from: string;
  /** Target repo-system name (alias-normalized). */
  to: string;
  kind: EdgeKind;
  blocking: EdgeBlocking;
  /** Rule id that produced the edge, e.g. "http:env-url" or "event:eventbridge-rule". */
  signal: string;
  /** Human-readable evidence: file (relative to repo) + short snippet. */
  evidence: string;
  confidence: Confidence;
  /**
   * Whether this edge constrains startup ORDER. Tolerant edges (JWKS auth,
   * redirect URLs, reconcilers) are still shown and still pull the target into
   * the start set, but don't gate sequence. Defaults to true when omitted.
   */
  ordering?: boolean;
}

export interface DerivedGraph {
  /** Repo-system names present in the graph. */
  nodes: string[];
  /** Deduped edges between nodes. */
  edges: DerivedEdge[];
}

/** A file read from a repo during discovery (content cached for the rules). */
export interface ScannedFile {
  /** Path relative to the repo root (used in evidence + filtering). */
  rel: string;
  /** Absolute path. */
  abs: string;
  content: string;
}

/** A repo's scanned inputs, passed to the rule functions. */
export interface ScannedRepo {
  repoName: string;
  repoPath: string;
  files: ScannedFile[];
}
