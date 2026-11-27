/**
 * One page of a GitHub list, fetched from GitHub one page at a time.
 *
 * The cursor carries GitHub's own page state: the REST page number for
 * branches, the GraphQL endCursor for repos. A ?q runs on GitHub before
 * the cut: branch names that start with q, repo names that contain it.
 */
import type * as http from "http";
import { sendJson } from "./http-helpers.js";
import {
  encodeCursor,
  isPageError,
  pageOf,
  readPageAsk,
  sendPageError,
  type Page,
  type PageAsk,
} from "./paging.js";

export type GhRun = (args: string[]) => Promise<string>;

/** GitHub's largest per_page and GraphQL first. */
export const GH_PAGE_MAX = 100;

export class BadCursor extends Error {}

const BRANCH_Q = /^[A-Za-z0-9._/-]{1,100}$/;
const REPO_Q = /^[A-Za-z0-9._-]{1,100}$/;

/** q from the query string: "" for none, null when it can't be a name. */
export function readListQ(
  p: URLSearchParams,
  kind: "branch" | "repo",
): string | null {
  const q = (p.get("q") ?? "").trim();
  if (!q) return "";
  return (kind === "branch" ? BRANCH_Q : REPO_Q).test(q) ? q : null;
}

function names(raw: string): string[] {
  try {
    const v = JSON.parse(raw.trim() || "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;

export async function branchPage(
  run: GhRun,
  slug: string,
  ask: PageAsk,
  q = "",
): Promise<Page<string>> {
  if (q) {
    if (ask.after && typeof ask.after.key !== "string") throw new BadCursor();
    const path = q.split("/").map(encodeURIComponent).join("/");
    const raw = await run([
      "api",
      `repos/${slug}/git/matching-refs/heads/${path}`,
      "--jq",
      "[.[].ref]",
    ]);
    const heads = names(raw).map((r) => r.replace(/^refs\/heads\//, ""));
    return pageOf(heads, ask, { key: (n) => n, id: (n) => n });
  }
  let page = 1;
  let per = Math.min(ask.limit, GH_PAGE_MAX);
  if (ask.after) {
    const k = ask.after.key;
    if (
      ask.after.id !== slug ||
      !Array.isArray(k) ||
      !isNum(k[0]) ||
      !isNum(k[1])
    )
      throw new BadCursor();
    [page, per] = [k[0], Math.min(k[1], GH_PAGE_MAX)];
  }
  const raw = await run([
    "api",
    `repos/${slug}/branches?per_page=${per}&page=${page}`,
    "--jq",
    "[.[].name]",
  ]);
  const items = names(raw);
  return {
    items,
    next: items.length === per ? encodeCursor([page + 1, per], slug) : null,
  };
}

export interface GhRepoNode {
  name: string;
  nameWithOwner: string;
  isArchived?: boolean;
  defaultBranchRef?: { name: string } | null;
}

interface GqlPage {
  nodes: (GhRepoNode | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const NODE = "name nameWithOwner isArchived defaultBranchRef { name }";
const OWNER_QUERY = `query($login: String!, $n: Int!, $after: String) {
  repositoryOwner(login: $login) {
    repositories(first: $n, after: $after, orderBy: { field: NAME, direction: ASC }) {
      nodes { ${NODE} } pageInfo { hasNextPage endCursor } } } }`;
const SEARCH_QUERY = `query($q: String!, $n: Int!, $after: String) {
  search(query: $q, type: REPOSITORY, first: $n, after: $after) {
    nodes { ... on Repository { ${NODE} } } pageInfo { hasNextPage endCursor } } }`;

const EMPTY: GqlPage = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
};

function gql(
  query: string,
  vars: Record<string, string | number>,
  after: string,
  jq: string,
) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars))
    args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  if (after) args.push("-f", `after=${after}`);
  return [...args, "--jq", jq];
}

const parseGql = (raw: string): GqlPage =>
  raw.trim() ? (JSON.parse(raw) as GqlPage) : EMPTY;

export interface RepoPageOf {
  nodes: GhRepoNode[];
  /** The owner whose page this was ("" for a q search across all of them). */
  owner: string;
  next: string | null;
}

/**
 * One page of repos: owner by owner in the given order, or one GitHub
 * search across every owner when q is set.
 */
export async function repoPage(
  run: GhRun,
  owners: string[],
  ask: PageAsk,
  q = "",
  onOwnerError?: (owner: string, e: Error) => void,
): Promise<RepoPageOf> {
  const n = Math.min(ask.limit, GH_PAGE_MAX);
  const k = ask.after?.key;
  if (q) {
    const id = `q:${q}`;
    if (
      ask.after &&
      (ask.after.id !== id || !Array.isArray(k) || typeof k[0] !== "string")
    )
      throw new BadCursor();
    const after = ask.after ? String((k as string[])[0]) : "";
    const search = `${q} in:name ${owners.map((o) => `user:${o}`).join(" ")}`;
    const p = parseGql(
      await run(gql(SEARCH_QUERY, { q: search, n }, after, ".data.search")),
    );
    return {
      nodes: p.nodes.filter((x): x is GhRepoNode => !!x?.nameWithOwner),
      owner: "",
      next:
        p.pageInfo.hasNextPage && p.pageInfo.endCursor
          ? encodeCursor([p.pageInfo.endCursor], id)
          : null,
    };
  }
  let i = 0;
  let after = "";
  if (ask.after) {
    i =
      Array.isArray(k) && typeof k[0] === "string" ? owners.indexOf(k[0]) : -1;
    if (ask.after.id !== "repos" || i < 0) throw new BadCursor();
    after = String((k as string[])[1] ?? "");
  }
  const owner = owners[i];
  let p = EMPTY;
  try {
    p = parseGql(
      await run(
        gql(
          OWNER_QUERY,
          { login: owner, n },
          after,
          ".data.repositoryOwner.repositories",
        ),
      ),
    );
  } catch (e) {
    onOwnerError?.(owner, e as Error);
  }
  const next =
    p.pageInfo.hasNextPage && p.pageInfo.endCursor
      ? encodeCursor([owner, p.pageInfo.endCursor], "repos")
      : i + 1 < owners.length
        ? encodeCursor([owners[i + 1], ""], "repos")
        : null;
  return {
    nodes: p.nodes.filter((x): x is GhRepoNode => !!x?.nameWithOwner),
    owner,
    next,
  };
}

/** Answer a paged GitHub list route: ?limit, ?cursor and ?q, then the page. */
export async function sendGhPage<T>(
  res: http.ServerResponse,
  params: URLSearchParams,
  kind: "branch" | "repo",
  fetch: (ask: PageAsk, q: string) => Promise<Page<T>>,
): Promise<void> {
  const ask = readPageAsk(params);
  if (isPageError(ask)) return sendPageError(res, ask);
  const q = readListQ(params, kind);
  if (q === null)
    return sendJson(
      res,
      {
        ok: false,
        code: "bad_q",
        error: `q is a ${kind} name, or part of one`,
      },
      400,
    );
  try {
    return sendJson(res, await fetch(ask, q));
  } catch (e) {
    if (!(e instanceof BadCursor)) throw e;
    return sendPageError(res, {
      status: 400,
      code: "bad_cursor",
      error: "cursor is not one this list gave: start again without it",
    });
  }
}
