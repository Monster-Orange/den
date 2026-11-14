/**
 * FB (den#81): Report an issue, the server's side. Every report is filed
 * as the person on GitHub (their `gh`); Den ships no secret of its own and
 * files nothing by itself. Nothing is sent without the person's click
 * after a preview of exactly what will be posted.
 *
 *   GET    /api/report              destinations, GitHub sign-in, the limit
 *   GET    /api/report/diagnostics  the server's sections, as exact text
 *   POST   /api/report/preview      {form, sections, redact, repo} → the
 *                                    exact title and body (redacted)
 *   POST   /api/report/send         a person's only. Over the hour's limit:
 *                                    429 (F7). Not signed in to GitHub: 409
 *                                    need github, nothing sent (F4), with
 *                                    the browser-tab path. The same title
 *                                    open: 409 duplicate (F5), unless
 *                                    `addTo` (a comment there) or `fileNew`
 *   GET    /api/report/drafts       Finish later's and agents' drafts
 *   POST   /api/report/drafts       save one (an agent's stays a draft)
 *   GET    /api/report/drafts/<id>  one, with its screenshot
 *   DELETE /api/report/drafts/<id>  a person discards one
 *   GET    /api/report/mine         My reports: the person's issues on the
 *                                    destinations, live from GitHub through
 *                                    their own gh (Den keeps no copy)
 *   POST   /api/report/github-send  no `gh`: the same send, through Den's
 *                                    GitHub App's device flow. The report is
 *                                    held here; the person's approval files
 *                                    it with that one token, then the token
 *                                    is dropped. GitHub refusing (the app
 *                                    not installed there, or no Issues:
 *                                    write) ends it refused: the page keeps
 *                                    the filled-in new-issue link
 *   GET    /api/report/github-send/<id>  that flow, for the page's poll
 *
 * `gh` runs through `deps.gh` (tests pass a fake: never the real one).
 */
import * as http from "http";
import * as os from "os";
import { spawn } from "child_process";
import {
  issueBody,
  issueTitle,
  type RedactNames,
  type ReportForm,
  type ReportKind,
} from "../../shared/feedback.js";
import type { Decision, FlowView } from "./device-flows.js";
import {
  draftStore,
  sentLog,
  type FeedbackSettings,
} from "../../shared/report-store.js";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ReportRouteDeps {
  settings: () => FeedbackSettings;
  stateDir: () => string;
  /** Runs `gh` with `args` (stdin: the body), as the person. */
  gh: (args: string[], stdin?: string) => Promise<GhResult>;
  /** The names to redact (this install's hosts, orgs, projects, …). */
  names: () => RedactNames;
  /** The server's diagnostics sections, as text. */
  diagnostics: () => Promise<Record<string, unknown>>;
  /** The agent asking (its id), or null for a person. */
  agentOf: (req: http.IncomingMessage) => string | null;
  /** Who counts for the hour's limit: the browser's session, or the CLI. */
  personOf: (req: http.IncomingMessage) => string;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  now?: () => number;
  /** The device flows (Den's GitHub App), for a person with no `gh`. */
  flows?: {
    start(
      purpose: "report",
    ): Promise<FlowView | { error: "busy" | "no_client_id" }>;
    get(id: string, purpose: "report"): FlowView | null;
  };
  /** An open issue with this title, read without a token (F5), or null. */
  searchOpen?: (
    repo: string,
    title: string,
  ) => Promise<{ number: number; url: string; title: string } | null>;
}

/** A report waiting for its person's approval in the device flow. */
interface Held {
  repo: string;
  title: string;
  body: string;
  addTo: number | null;
  who: string;
  draftId?: string;
  stateDir: string;
  maxPerHour: number;
  at: number;
}
const HELD = new Map<string, Held>();
/** Longer than any device code lasts (GitHub's are 15 minutes). */
const HELD_MS = 20 * 60_000;

function sweepHeld(now: number): void {
  for (const [id, h] of HELD) if (now - h.at > HELD_MS) HELD.delete(id);
}

/**
 * The device flow's decision for a held report: file it as the person who
 * approved, with that flow's token (`ctx.api`), once.
 */
export async function decideReport(
  ctx: {
    id: string;
    api(
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }>;
  },
  now: () => number = Date.now,
): Promise<Decision> {
  const h = HELD.get(ctx.id);
  HELD.delete(ctx.id);
  if (!h) return { refused: "this report is no longer held: send it again" };
  const log = sentLog(h.stateDir);
  if (log.recent(h.who, now()) >= h.maxPerHour)
    return { refused: `at most ${h.maxPerHour} reports an hour` };
  const r =
    h.addTo !== null
      ? await ctx.api("POST", `/repos/${h.repo}/issues/${h.addTo}/comments`, {
          body: h.body,
        })
      : await ctx.api("POST", `/repos/${h.repo}/issues`, {
          title: h.title,
          body: h.body,
        });
  if (r.status !== 201)
    return {
      refused:
        r.status === 403 || r.status === 404
          ? `GitHub refused it (${r.status}): Den's GitHub App isn't installed on ${h.repo}, or can't write issues there. Nothing was sent; the link files it in a browser tab.`
          : `GitHub refused it (${r.status}). Nothing was sent; the link files it in a browser tab.`,
    };
  log.add(h.who, now());
  if (h.draftId) draftStore(h.stateDir).remove(h.draftId);
  return {
    ok: {
      url: typeof r.body.html_url === "string" ? r.body.html_url : "",
      repo: h.repo,
      added: h.addTo !== null,
    },
  };
}

/** GET /api/report/github-send/<id>. */
const FLOW_PATH = /^\/api\/report\/github-send\/([A-Za-z0-9_-]{16,64})$/;
/** GET and DELETE /api/report/drafts/<id>. */
const DRAFT_PATH = /^\/api\/report\/drafts\/([a-f0-9]{16})$/;

const KINDS: readonly ReportKind[] = ["bug", "idea", "question"];

/** What the client sends for a preview or a send. */
interface Draftish {
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  sections?: unknown;
  /** The browser's own sections (Browser, Page), as text. */
  client?: unknown;
  redact?: unknown;
  repo?: unknown;
}

function formOf(b: Draftish): ReportForm | string {
  const kind = KINDS.includes(b.kind as ReportKind)
    ? (b.kind as ReportKind)
    : null;
  if (!kind) return "kind: bug, idea or question";
  if (typeof b.title !== "string" || !b.title.trim())
    return "a title is needed";
  if (b.title.length > 200) return "the title is longer than 200 characters";
  const description = typeof b.description === "string" ? b.description : "";
  if (description.length > 20_000)
    return "the description is longer than 20,000 characters";
  const sections: Record<string, boolean> = {};
  if (b.sections && typeof b.sections === "object")
    for (const [k, v] of Object.entries(b.sections as Record<string, unknown>))
      sections[k] = v === true;
  return { kind, title: b.title, description, sections };
}

/** The browser-tab path: a new-issue page with the text filled in. */
export function newIssueUrl(repo: string, title: string, body: string): string {
  // GitHub refuses very long URLs: the body is cut, and says so.
  const max = 6000;
  const cut =
    body.length > max
      ? `${body.slice(0, max)}\n\n…(cut: paste the rest)`
      : body;
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(cut)}`;
}

/** The exact title and body that would be posted. */
async function compose(
  b: Draftish,
  d: ReportRouteDeps,
): Promise<{ title: string; body: string; repo: string } | string> {
  const form = formOf(b);
  if (typeof form === "string") return form;
  const s = d.settings();
  const repo = typeof b.repo === "string" ? b.repo : s.repos[0];
  if (!repo || !s.repos.includes(repo)) return "no such destination";
  const server = await d.diagnostics();
  const client =
    b.client && typeof b.client === "object"
      ? (b.client as Record<string, unknown>)
      : {};
  const diag: Record<string, unknown> = { ...server };
  for (const [k, v] of Object.entries(client))
    if (typeof v === "string") diag[k] = v.slice(0, 20_000);
  const opts = { names: b.redact !== false };
  const names = d.names();
  return {
    title: issueTitle(form, names, opts),
    body: issueBody(form, diag, names, opts),
    repo,
  };
}

/** Whether `gh` is signed in to GitHub (`gh auth status`). */
async function ghSignedIn(d: ReportRouteDeps): Promise<boolean> {
  try {
    return (
      (await d.gh(["auth", "status", "--hostname", "github.com"])).code === 0
    );
  } catch {
    return false;
  }
}

/** My reports' one search: the person's issues, each with its last reply. */
const MINE_QUERY =
  "query($q:String!,$n:Int!){viewer{login} search(query:$q,type:ISSUE,first:$n){nodes{... on Issue{number title url state updatedAt repository{nameWithOwner} comments(last:1){totalCount nodes{bodyText createdAt author{login}}}}}}}";

export interface MyReport {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  updatedAt: string;
  replies: number;
  lastReply?: { text: string; at: string; by: string };
}

/** GitHub's search answer as My reports rows; anything else is left out. */
export function myReportsOf(raw: unknown): MyReport[] {
  const nodes = (raw as { data?: { search?: { nodes?: unknown[] } } } | null)
    ?.data?.search?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: MyReport[] = [];
  for (const n of nodes as Record<string, unknown>[]) {
    if (!n || typeof n.number !== "number" || typeof n.url !== "string")
      continue;
    const repo = (n.repository as { nameWithOwner?: unknown } | undefined)
      ?.nameWithOwner;
    const c = (n.comments ?? {}) as {
      totalCount?: unknown;
      nodes?: Record<string, unknown>[];
    };
    const last = Array.isArray(c.nodes) ? c.nodes[0] : undefined;
    const row: MyReport = {
      repo: typeof repo === "string" ? repo : "",
      number: n.number,
      title: typeof n.title === "string" ? n.title : "",
      url: n.url,
      state: n.state === "OPEN" ? "open" : "closed",
      updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : "",
      replies: typeof c.totalCount === "number" ? c.totalCount : 0,
    };
    if (last && typeof last.bodyText === "string") {
      const text = last.bodyText.replace(/\s+/g, " ").trim();
      row.lastReply = {
        text: text.length > 140 ? `${text.slice(0, 139)}…` : text,
        at: typeof last.createdAt === "string" ? last.createdAt : "",
        by:
          typeof (last.author as { login?: unknown } | undefined)?.login ===
          "string"
            ? (last.author as { login: string }).login
            : "",
      };
    }
    out.push(row);
  }
  return out;
}

/** An open issue on `repo` with exactly this title, if there is one. */
async function sameTitle(
  d: ReportRouteDeps,
  repo: string,
  title: string,
): Promise<{ number: number; url: string; title: string } | null> {
  const r = await d.gh([
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--search",
    `${title} in:title`,
    "--json",
    "number,title,url",
    "--limit",
    "20",
  ]);
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.stdout) as {
      number: number;
      title: string;
      url: string;
    }[];
    const want = title.trim().toLowerCase();
    return list.find((i) => i.title.trim().toLowerCase() === want) ?? null;
  } catch {
    return null;
  }
}

export function handleReportRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: ReportRouteDeps,
): boolean {
  if (!/^\/api\/report(?:\/|$)/.test(pathname)) return false;
  const now = d.now ?? Date.now;
  const json = async (): Promise<Draftish & Record<string, unknown>> =>
    JSON.parse((await d.readBody(req)) || "{}") as Draftish &
      Record<string, unknown>;
  const run = (f: () => Promise<void>) => {
    f().catch((e) => {
      if (!res.headersSent)
        d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    });
    return true;
  };
  const off = () =>
    d.sendJson(
      res,
      {
        ok: false,
        error: "reports are turned off here (feedback.enabled: false)",
      },
      404,
    );

  if (pathname === "/api/report" && req.method === "GET")
    return run(async () => {
      const s = d.settings();
      const who = d.personOf(req);
      d.sendJson(res, {
        ok: true,
        enabled: s.enabled,
        repos: s.repos.map((repo) => ({ repo })),
        github: { signedIn: await ghSignedIn(d), deviceFlow: !!d.flows },
        maxPerHour: s.maxPerHour,
        captureSeconds: s.captureSeconds,
        sentThisHour: sentLog(d.stateDir()).recent(who, now()),
      });
    });

  if (pathname === "/api/report/diagnostics" && req.method === "GET")
    return run(async () => {
      if (!d.settings().enabled) return off();
      d.sendJson(res, { ok: true, sections: await d.diagnostics() });
    });

  if (pathname === "/api/report/preview" && req.method === "POST")
    return run(async () => {
      if (!d.settings().enabled) return off();
      const c = await compose(await json(), d);
      if (typeof c === "string")
        return d.sendJson(res, { ok: false, error: c }, 400);
      d.sendJson(res, { ok: true, ...c });
    });

  if (pathname === "/api/report/send" && req.method === "POST")
    return run(async () => {
      if (!d.settings().enabled) return off();
      if (d.agentOf(req))
        return d.sendJson(
          res,
          {
            ok: false,
            error: "only a person sends a report; an agent's stays a draft",
          },
          403,
        );
      const b = await json();
      const c = await compose(b, d);
      if (typeof c === "string")
        return d.sendJson(res, { ok: false, error: c }, 400);
      const s = d.settings();
      const who = d.personOf(req);
      const log = sentLog(d.stateDir());
      if (log.recent(who, now()) >= s.maxPerHour)
        return d.sendJson(
          res,
          {
            ok: false,
            limit: s.maxPerHour,
            nextAt: new Date(log.nextAt(who, now())).toISOString(),
            error: `at most ${s.maxPerHour} reports an hour`,
          },
          429,
        );
      if (!(await ghSignedIn(d)))
        return d.sendJson(
          res,
          {
            ok: false,
            need: "github",
            error: "sending needs a GitHub sign-in: nothing was sent",
            deviceFlow: !!d.flows,
            newIssueUrl: newIssueUrl(c.repo, c.title, c.body),
          },
          409,
        );
      const addTo = Number.isInteger(b.addTo) ? (b.addTo as number) : null;
      if (addTo === null && b.fileNew !== true) {
        const dup = await sameTitle(d, c.repo, c.title);
        if (dup) return d.sendJson(res, { ok: false, duplicate: dup }, 409);
      }
      const r =
        addTo !== null
          ? await d.gh(
              [
                "issue",
                "comment",
                String(addTo),
                "-R",
                c.repo,
                "--body-file",
                "-",
              ],
              c.body,
            )
          : await d.gh(
              [
                "issue",
                "create",
                "-R",
                c.repo,
                "--title",
                c.title,
                "--body-file",
                "-",
              ],
              c.body,
            );
      if (r.code !== 0)
        return d.sendJson(
          res,
          {
            ok: false,
            error: `GitHub refused it: ${(r.stderr || r.stdout).trim().split("\n")[0] || `gh exited ${r.code}`}`,
            newIssueUrl: newIssueUrl(c.repo, c.title, c.body),
          },
          502,
        );
      log.add(who, now());
      if (typeof b.draftId === "string")
        draftStore(d.stateDir()).remove(b.draftId);
      const url = r.stdout.trim().split("\n").pop() ?? "";
      d.sendJson(res, { ok: true, url, repo: c.repo, added: addTo !== null });
    });

  if (pathname === "/api/report/github-send" && req.method === "POST")
    return run(async () => {
      if (!d.settings().enabled) return off();
      if (d.agentOf(req))
        return d.sendJson(
          res,
          { ok: false, error: "only a person sends a report" },
          403,
        );
      const b = await json();
      const c = await compose(b, d);
      if (typeof c === "string")
        return d.sendJson(res, { ok: false, error: c }, 400);
      const link = newIssueUrl(c.repo, c.title, c.body);
      const s = d.settings();
      const who = d.personOf(req);
      const log = sentLog(d.stateDir());
      if (log.recent(who, now()) >= s.maxPerHour)
        return d.sendJson(
          res,
          {
            ok: false,
            limit: s.maxPerHour,
            nextAt: new Date(log.nextAt(who, now())).toISOString(),
            error: `at most ${s.maxPerHour} reports an hour`,
          },
          429,
        );
      const addTo = Number.isInteger(b.addTo) ? (b.addTo as number) : null;
      if (addTo === null && b.fileNew !== true && d.searchOpen) {
        const dup = await d.searchOpen(c.repo, c.title).catch(() => null);
        if (dup) return d.sendJson(res, { ok: false, duplicate: dup }, 409);
      }
      const v = d.flows ? await d.flows.start("report") : null;
      if (!v || "error" in v)
        return d.sendJson(
          res,
          {
            ok: false,
            error:
              v?.error === "busy"
                ? "too many GitHub sign-ins at once: try again in a minute"
                : "no GitHub App is set up here (web.github_client_id)",
            newIssueUrl: link,
          },
          v?.error === "busy" ? 503 : 409,
        );
      sweepHeld(now());
      HELD.set(v.id, {
        repo: c.repo,
        title: c.title,
        body: c.body,
        addTo,
        who,
        ...(typeof b.draftId === "string" ? { draftId: b.draftId } : {}),
        stateDir: d.stateDir(),
        maxPerHour: s.maxPerHour,
        at: now(),
      });
      d.sendJson(res, { ok: true, flow: v, newIssueUrl: link });
    });

  const fm = FLOW_PATH.exec(pathname);
  if (fm && req.method === "GET")
    return run(async () => {
      const v = d.flows?.get(fm[1], "report") ?? null;
      d.sendJson(
        res,
        v ? { ok: true, flow: v } : { ok: false, error: "no such sign-in" },
        v ? 200 : 404,
      );
    });

  if (pathname === "/api/report/drafts" && req.method === "GET")
    return run(async () => {
      // The list leaves screenshots out: one is read when it is opened.
      const drafts = draftStore(d.stateDir())
        .list()
        .map(({ shot, ...rest }) => (shot ? { ...rest, hasShot: true } : rest));
      d.sendJson(res, { ok: true, drafts });
    });

  if (pathname === "/api/report/mine" && req.method === "GET")
    return run(async () => {
      if (!d.settings().enabled) return off();
      if (d.agentOf(req))
        return d.sendJson(
          res,
          { ok: false, error: "My reports is the person's own" },
          403,
        );
      if (!(await ghSignedIn(d)))
        return d.sendJson(res, { ok: true, signedIn: false, reports: [] });
      const s = d.settings();
      const q = [
        ...s.repos.map((r) => `repo:${r}`),
        "author:@me is:issue sort:updated-desc",
      ].join(" ");
      const r = await d.gh([
        "api",
        "graphql",
        "-f",
        `query=${MINE_QUERY}`,
        "-f",
        `q=${q}`,
        "-F",
        `n=${s.myReportsMax}`,
      ]);
      if (r.code !== 0)
        return d.sendJson(
          res,
          {
            ok: false,
            error: (r.stderr || "GitHub did not answer").split("\n")[0],
          },
          502,
        );
      let raw: unknown = null;
      try {
        raw = JSON.parse(r.stdout);
      } catch {
        /* not JSON: none */
      }
      // `me`: the person's login, so their own replies aren't new ones.
      const me = (raw as { data?: { viewer?: { login?: unknown } } } | null)
        ?.data?.viewer?.login;
      d.sendJson(res, {
        ok: true,
        signedIn: true,
        me: typeof me === "string" ? me : "",
        reports: myReportsOf(raw),
      });
    });

  if (pathname === "/api/report/drafts" && req.method === "POST")
    return run(async () => {
      if (!d.settings().enabled) return off();
      const b = await json();
      const form = formOf(b);
      if (typeof form === "string")
        return d.sendJson(res, { ok: false, error: form }, 400);
      const agent = d.agentOf(req);
      const shot =
        typeof b.shot === "string" &&
        /^data:image\/(png|jpeg|webp);base64,/.test(b.shot) &&
        b.shot.length < 8_000_000
          ? b.shot
          : undefined;
      const rec = draftStore(d.stateDir()).save({
        ...(typeof b.id === "string" && !agent ? { id: b.id } : {}),
        by: agent ? `agent:${agent}` : "person",
        kind: form.kind,
        title: form.title,
        description: form.description,
        sections: form.sections,
        redact: b.redact !== false,
        ...(typeof b.repo === "string" ? { repo: b.repo } : {}),
        ...(shot ? { shot } : {}),
      });
      d.sendJson(res, {
        ok: true,
        draft: { id: rec.id, savedAt: rec.savedAt },
      });
    });

  const m = DRAFT_PATH.exec(pathname);
  if (m && req.method === "GET")
    return run(async () => {
      const draft = draftStore(d.stateDir()).get(m[1]);
      d.sendJson(
        res,
        draft ? { ok: true, draft } : { ok: false, error: "no such draft" },
        draft ? 200 : 404,
      );
    });
  if (m && req.method === "DELETE")
    return run(async () => {
      if (d.agentOf(req))
        return d.sendJson(
          res,
          { ok: false, error: "only a person discards a draft" },
          403,
        );
      const gone = draftStore(d.stateDir()).remove(m[1]);
      d.sendJson(
        res,
        gone ? { ok: true } : { ok: false, error: "no such draft" },
        gone ? 200 : 404,
      );
    });

  return false;
}

/** The machine's section: what it runs on, never who or where. */
export function machineSection(): string {
  return [
    `os: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    `cpus: ${os.cpus().length}`,
    `memory: ${Math.round(os.totalmem() / 1024 ** 3)} GB`,
    `node: ${process.versions.node}`,
  ].join("\n");
}

/**
 * The real `gh`, as the person running this server (never in tests: they
 * pass a fake). `stdin` is the body; a minute at most.
 */
export function runGh(args: string[], stdin?: string): Promise<GhResult> {
  return new Promise((ok) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      });
    } catch (e) {
      return ok({ code: 127, stdout: "", stderr: (e as Error).message });
    }
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      ok({ code: 127, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ok({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.end(stdin ?? "");
  });
}

/**
 * F5 with no `gh`: an open issue with this exact title, from GitHub's
 * public search (no token: public repositories only; a failure is null).
 */
export function publicSearchOpen(apiBase: string) {
  return async (
    repo: string,
    title: string,
  ): Promise<{ number: number; url: string; title: string } | null> => {
    const q = `repo:${repo} is:issue is:open in:title "${title.replace(/"/g, "")}"`;
    try {
      const r = await fetch(
        `${apiBase}/search/issues?per_page=20&q=${encodeURIComponent(q)}`,
        {
          headers: { accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) return null;
      const j = (await r.json()) as {
        items?: { number: number; title: string; html_url: string }[];
      };
      const want = title.trim().toLowerCase();
      const hit = (j.items ?? []).find(
        (i) => i.title.trim().toLowerCase() === want,
      );
      return hit
        ? { number: hit.number, title: hit.title, url: hit.html_url }
        : null;
    } catch {
      return null;
    }
  };
}
