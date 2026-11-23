/**
 * Issue 476 (REVIEW-MESH-SPEC RV-4): what the reviewer posts. In S1 it
 * posts under the person's own GitHub login, so every review names the
 * agent, the install and whose behalf, and says it is not the person's
 * approval. It approves only when `agents_may_approve` is on. Each finding
 * carries a hidden marker so later rounds can track it. The check summary
 * shows depth, model, tokens or cost, and finding counts (RV-8 item 15).
 */
import { redactSecrets } from "../../redact.js";
export interface Who {
  agent: string;
  install: string;
  /** The GitHub login the agent works for. */
  person: string;
}

export function reviewHeader(w: Who): string {
  return `**Agent review by ${w.agent} on ${w.person}'s Den** (${w.install}). This is not ${w.person}'s approval.`;
}

export function reviewEvent(o: {
  blocking: number;
  agentsMayApprove: boolean;
}): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  if (!o.agentsMayApprove) return "COMMENT";
  return o.blocking > 0 ? "REQUEST_CHANGES" : "APPROVE";
}

export interface FindingRef {
  id: string;
  severity: "high" | "medium" | "low";
  lens: string;
  /** The head the finding was made on. */
  sha: string;
}

const VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function findingMarker(f: FindingRef): string {
  for (const [k, v] of Object.entries(f))
    if (!VALUE_RE.test(v)) throw new Error(`finding ${k} can't go in a marker`);
  return `<!-- den-review-finding v=1 id=${f.id} sev=${f.severity} lens=${f.lens} sha=${f.sha} -->`;
}

const FINDING_RE =
  /<!-- den-review-finding v=1 id=(\S+) sev=(high|medium|low) lens=(\S+) sha=(\S+) -->/g;

/** The findings marked in comment bodies, in order. */
export function parseFindings(bodies: readonly string[]): FindingRef[] {
  const out: FindingRef[] = [];
  for (const b of bodies)
    for (const m of b.matchAll(FINDING_RE))
      out.push({
        id: m[1],
        severity: m[2] as FindingRef["severity"],
        lens: m[3],
        sha: m[4],
      });
  return out;
}

export function checkSummary(o: {
  depth: string;
  model: string;
  tokens: number | null;
  costUsd: number | null;
  findings: { blocking: number; other: number };
}): string {
  const lines = [`Depth: ${o.depth}`, `Model: ${o.model}`];
  if (o.tokens !== null)
    lines.push(`Tokens: ${o.tokens.toLocaleString("en-US")}`);
  if (o.costUsd !== null) lines.push(`Cost: $${o.costUsd.toFixed(2)}`);
  lines.push(
    `Findings: ${o.findings.blocking} blocking, ${o.findings.other} other`,
  );
  return lines.join("\n");
}

/**
 * Den's own token kinds (den_at_, den_sk_, den_ek_, den_gr_ …). redact.ts
 * covers every kind once issue 52's widening lands; the review path covers
 * them now either way.
 */
const DEN_TOKEN_RE = /\bden_[a-z]{2}_[A-Za-z0-9_-]{20,}/g;

/**
 * A leg's own words, scrubbed of secrets before Den posts them. A leg
 * reads untrusted PR content (a fork's, after a person's "Review this"),
 * so an injected leg could try to publish a token it read.
 */
export function scrubLegText(text: string): string {
  return redactSecrets(text).replace(DEN_TOKEN_RE, "[REDACTED]");
}
