/**
 * Issue 648: one approval for the connection, every link and every create.
 * The contract agreed with Hub (on issue 648; Hub's half is its issue 258):
 *
 *   Den → Hub's Connect page: `review=1&projects=<base64url JSON>`, the
 *   JSON `[{key, name, repos}]`: at most 50 projects and 6 KB encoded, keys
 *   [a-z0-9-]{1,64} once each, never the catch-all `default` (issue 649).
 *   Den keeps the sha256 of the `projects` value it sent. The list goes in
 *   the Connect page's URL (so the browser's history keeps it): it never
 *   carries anything but these project keys, names and owner/name repos;
 *   no tokens, no paths.
 *
 *   Hub → POST /connect/token adds `review: {version: 1, projects_hash,
 *   links: [{key, project: {id, slug, name}, how: linked|created}],
 *   skipped: [{key, why: person|failed|permission, detail?}]}`, every key
 *   sent exactly once. `projects_hash` is the sha256 of the `projects`
 *   bytes Hub received: a different one means another list, and Den drops
 *   the review.
 *
 * Anything else (no review, an older Hub, a cap passed): issue 646's flow.
 */
import { createHash } from "crypto";
import { isCatchAllProject } from "./catch-all-project.js";

export const REVIEW_MAX_PROJECTS = 50;
export const REVIEW_MAX_BYTES = 6144;
const KEY = /^[a-z0-9-]{1,64}$/;
const TEXT_MAX = 200;

export interface ReviewProject {
  key: string;
  name: string;
  repos: string[];
}

/** Why a review falls back to issue 646's flow; the page words each one. */
export type FallbackCode =
  | "empty"
  | "too-many"
  | "too-big"
  | "bad-key"
  | "twice"
  | "old-hub"
  | "other-list"
  | "bad-answer"
  | "rebind";

export type ReviewParam =
  | { ok: true; param: string; hash: string; keys: string[] }
  | { ok: false; why: string; code: FallbackCode };

/** What Connect sends, or why it sends nothing (then issue 646's flow). */
export function reviewParam(projects: ReviewProject[]): ReviewParam {
  const list = projects.filter((p) => !isCatchAllProject(p.key));
  if (!list.length)
    return { ok: false, why: "no projects to link", code: "empty" };
  if (list.length > REVIEW_MAX_PROJECTS)
    return {
      ok: false,
      why: `more than ${REVIEW_MAX_PROJECTS} projects`,
      code: "too-many",
    };
  const seen = new Set<string>();
  for (const p of list) {
    if (!KEY.test(p.key))
      return {
        ok: false,
        why: `project "${p.key.slice(0, 64)}" has a name Hub can't match (a-z, 0-9 and -, at most 64)`,
        code: "bad-key",
      };
    if (seen.has(p.key))
      return {
        ok: false,
        why: `project "${p.key}" is listed twice`,
        code: "twice",
      };
    seen.add(p.key);
  }
  const body = list.map((p) => ({
    key: p.key,
    name: p.name.slice(0, TEXT_MAX),
    repos: p.repos,
  }));
  const param = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  if (param.length > REVIEW_MAX_BYTES)
    return { ok: false, why: "the list is over 6 KB", code: "too-big" };
  return {
    ok: true,
    param,
    hash: createHash("sha256").update(param).digest("hex"),
    keys: [...seen],
  };
}

export interface GrantLink {
  key: string;
  project: { id: string; slug: string; name: string };
  how: "linked" | "created";
}
export interface GrantSkip {
  key: string;
  why: "person" | "failed" | "permission";
  detail?: string;
}

export type GrantReview =
  | { ok: true; links: GrantLink[]; skipped: GrantSkip[] }
  | { ok: false; why: string; code: FallbackCode };

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.length <= TEXT_MAX ? v : null;
const bad = (
  why = "Hub's answer about the projects isn't one Den reads",
  code: FallbackCode = "bad-answer",
) => ({ ok: false, why, code }) as const;

/** Hub's `review`, checked against what Den sent; else why it's dropped. */
export function parseGrantReview(
  raw: unknown,
  sent: { hash: string; keys: string[] },
): GrantReview {
  if (raw === undefined || raw === null)
    return bad("this Hub doesn't link projects in Connect yet", "old-hub");
  if (typeof raw !== "object") return bad();
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return bad();
  if (r.projects_hash !== sent.hash)
    return bad("Hub's answer is for another list of projects", "other-list");
  if (!Array.isArray(r.links) || !Array.isArray(r.skipped)) return bad();
  const want = new Set(sent.keys);
  const got = new Set<string>();
  const take = (k: unknown): string | null => {
    if (typeof k !== "string" || !want.has(k) || got.has(k)) return null;
    got.add(k);
    return k;
  };
  const links: GrantLink[] = [];
  for (const l of r.links as unknown[]) {
    const o = (l ?? {}) as Record<string, unknown>;
    const key = take(o.key);
    const p = (o.project ?? {}) as Record<string, unknown>;
    const id = text(p.id);
    const slug = text(p.slug);
    const name = text(p.name);
    if (!key || !id || !slug || !name) return bad();
    if (o.how !== "linked" && o.how !== "created") return bad();
    links.push({ key, project: { id, slug, name }, how: o.how });
  }
  const skipped: GrantSkip[] = [];
  for (const s of r.skipped as unknown[]) {
    const o = (s ?? {}) as Record<string, unknown>;
    const key = take(o.key);
    if (!key) return bad();
    if (o.why !== "person" && o.why !== "failed" && o.why !== "permission")
      return bad();
    const detail = text(o.detail);
    skipped.push({ key, why: o.why, ...(detail ? { detail } : {}) });
  }
  if (got.size !== want.size) return bad();
  return { ok: true, links, skipped };
}
