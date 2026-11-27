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
  type PageError,
} from "./paging.js";

export type GhRun = (args: string[]) => Promise<string>;
export const GH_PAGE_MAX = 100;

export const firstAsk = (list: string, limit = GH_PAGE_MAX): PageAsk => ({
  list,
  limit,
  after: null,
  dir: "next",
  page: null,
  at: null,
});

export class BadCursor extends Error {}
export class BadPage extends Error {}

export const isBranchPath = (s: string, max = 255): boolean =>
  s.length <= max &&
  /^[A-Za-z0-9._/-]+$/.test(s) &&
  s.split("/").every((p) => p !== "" && p !== "." && p !== "..");
const REPO_Q = /^[A-Za-z0-9._-]{1,100}$/;
export function readListQ(
  p: URLSearchParams,
  kind: "branch" | "repo",
): string | null {
  const q = (p.get("q") ?? "").trim();
  if (!q) return "";
  return (
    kind === "branch" ? isBranchPath(q.replace(/\/$/, ""), 100) : REPO_Q.test(q)
  )
    ? q
    : null;
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
    return pageOf(heads, ask, { key: (n) => n, id: (n) => n, total: true });
  }
  if (ask.at === "last")
    throw new BadPage("this list has no last page: GitHub gives no count");
  let page = ask.page ?? 1;
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
  const [raw, def] = await Promise.all([
    run([
      "api",
      `repos/${slug}/branches?per_page=${per}&page=${page}`,
      "--jq",
      "[.[].name]",
    ]),
    run(["api", `repos/${slug}`, "--jq", ".default_branch"]).catch(() => ""),
  ]);
  const got = names(raw);
  const d = def.trim();
  const pin = isBranchPath(d) ? d : "";
  const rest = got.filter((n) => n !== pin);
  const to = (p: number, dir: "next" | "prev") =>
    encodeCursor(ask.list, { key: [p, per], id: slug }, dir);
  return {
    items: page === 1 && pin ? [pin, ...rest] : rest,
    next: got.length === per ? to(page + 1, "next") : null,
    prev: page > 1 ? to(page - 1, "prev") : null,
    offset: (page - 1) * per,
    page,
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
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

const NODE = "name nameWithOwner isArchived defaultBranchRef { name }";
const INFO = "pageInfo { hasNextPage hasPreviousPage startCursor endCursor }";
const VARS = "$first: Int, $last: Int, $after: String, $before: String";
const SPAN = "first: $first, last: $last, after: $after, before: $before";
const OWNER_QUERY = `query($login: String!, ${VARS}) {
  repositoryOwner(login: $login) {
    repositories(${SPAN}, orderBy: { field: NAME, direction: ASC }) {
      nodes { ${NODE} } ${INFO} } } }`;
const SEARCH_QUERY = `query($q: String!, ${VARS}) {
  search(query: $q, type: REPOSITORY, ${SPAN}) {
    nodes { ... on Repository { ${NODE} } } ${INFO} } }`;

const EMPTY: GqlPage = {
  nodes: [],
  pageInfo: {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  },
};

function parseGql(raw: string): GqlPage {
  try {
    const p = JSON.parse(raw) as Partial<GqlPage> | null;
    return Array.isArray(p?.nodes) && p.pageInfo ? (p as GqlPage) : EMPTY;
  } catch {
    return EMPTY;
  }
}

interface Span {
  back: boolean;
  from: string;
}

function gql(
  query: string,
  vars: Record<string, string>,
  n: number,
  span: Span,
  jq: string,
) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  args.push("-F", `${span.back ? "last" : "first"}=${n}`);
  if (span.from)
    args.push("-f", `${span.back ? "before" : "after"}=${span.from}`);
  return [...args, "--jq", jq];
}

export interface RepoPageOf {
  nodes: GhRepoNode[];
  next: string | null;
  prev: string | null;
}

const nodesOf = (p: GqlPage) =>
  p.nodes.filter((x): x is GhRepoNode => !!x?.nameWithOwner);

function spanOf(
  ask: PageAsk,
  id: string,
  scope: string[],
): { at: number; span: Span } {
  if (ask.page !== null && ask.page !== 1)
    throw new BadPage(
      "this list pages by Next and Prev: GitHub gives no count",
    );
  if (ask.at === "last")
    return { at: scope.length - 1, span: { back: true, from: "" } };
  if (!ask.after) return { at: 0, span: { back: false, from: "" } };
  const k = ask.after.key;
  const at =
    Array.isArray(k) && typeof k[0] === "string" ? scope.indexOf(k[0]) : -1;
  if (ask.after.id !== id || at < 0 || !Array.isArray(k)) throw new BadCursor();
  return { at, span: { back: ask.dir === "prev", from: String(k[1] ?? "") } };
}

export async function repoPage(
  run: GhRun,
  owners: string[],
  ask: PageAsk,
  q = "",
  onOwnerError?: (owner: string, e: Error) => void,
): Promise<RepoPageOf> {
  const n = Math.min(ask.limit, GH_PAGE_MAX);
  const id = q ? `q:${q}` : "repos";
  const scope = q ? [""] : owners;
  const { at, span } = spanOf(ask, id, scope);
  const owner = scope[at];
  let p = EMPTY;
  try {
    p = parseGql(
      await run(
        q
          ? gql(
              SEARCH_QUERY,
              { q: `${q} in:name ${owners.map((o) => `user:${o}`).join(" ")}` },
              n,
              span,
              ".data.search",
            )
          : gql(
              OWNER_QUERY,
              { login: owner },
              n,
              span,
              ".data.repositoryOwner.repositories",
            ),
      ),
    );
  } catch (e) {
    if (q) throw e;
    onOwnerError?.(owner, e as Error);
  }
  const to = (o: string, from: string, dir: "next" | "prev") =>
    encodeCursor(ask.list, { key: [o, from], id }, dir);
  const { hasNextPage, hasPreviousPage, startCursor, endCursor } = p.pageInfo;
  return {
    nodes: nodesOf(p),
    next:
      hasNextPage && endCursor
        ? to(owner, endCursor, "next")
        : at + 1 < scope.length
          ? to(scope[at + 1], "", "next")
          : null,
    prev:
      hasPreviousPage && startCursor
        ? to(owner, startCursor, "prev")
        : at > 0
          ? to(scope[at - 1], "", "prev")
          : null,
  };
}

export async function sendGhPage<T>(
  res: http.ServerResponse,
  params: URLSearchParams,
  kind: "branch" | "repo",
  list: string,
  fetch: (ask: PageAsk, q: string) => Promise<Page<T>>,
): Promise<void> {
  const ask = readPageAsk(params, list);
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
    const bad: PageError | null =
      e instanceof BadCursor
        ? {
            status: 400,
            code: "bad_cursor",
            error: "cursor is not one this list gave: start again without it",
          }
        : e instanceof BadPage
          ? { status: 400, code: "bad_page", error: e.message }
          : null;
    if (!bad) throw e;
    return sendPageError(res, bad);
  }
}
