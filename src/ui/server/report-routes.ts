/**
 * FB (den#81): Report an issue, the server's side. Every report is filed
 * as the person on GitHub (their `gh`); Den ships no secret of its own and
 * files nothing by itself. Nothing is sent without the person's click
 * after a preview of exactly what will be posted.
 *
 *   GET    /api/report              destinations (each with its visibility
 *                                    on GitHub, issue 415), GitHub sign-in,
 *                                    the limit
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
 *   GET    /api/report/shot-share?repo=  issue 403: whether a screenshot
 *                                    for that destination goes on to Hub
 *                                    ({ share, recipient }), for Review
 *   GET    /api/report/shots/<id>   issue 403: a filed report's kept
 *                                    screenshot (base64 PNG): the person
 *                                    (CLI token, or a signed-in browser
 *                                    with its approval key) or this
 *                                    install's own agent; 401 with no
 *                                    proof, 403 a project agent (shotReaderOf)
 *
 * Issue 403: a send (either way) may carry `shot`, the masked PNG as a
 * data URL, and `shareShot`. Nothing about it leaves until the issue (or
 * comment) is filed: then the PNG is kept here, keyed by the report id
 * (report-shots.ts), and, ticked and Hub-connected, sent to Hub
 * (report-shot-hub.ts), and the filed body's screenshot line is updated
 * to say so. The GitHub App's way does that after the person approved
 * and GitHub filed it. Hub saying no never stops the filing. The line
 * names the tool that reads it, never a URL, a path or Hub's recipient.
 *
 * `gh` runs through `deps.gh` (tests pass a fake: never the real one).
 */
import type { FiledText } from "../../shared/filed-text-check.js";
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
  repoVisibilities,
  type PublicLookup,
  type RepoVisibility,
} from "./report-visibility.js";
import {
  draftStore,
  sentLog,
  type FeedbackSettings,
} from "../../shared/report-store.js";
import {
  MAX_KEPT_BYTES,
  REPORT_ID,
  newReportId,
  pngOfDataUrl,
  shotStore,
} from "../../shared/report-shots.js";
import type { ReportShotHub, UploadWhy } from "./report-shot-hub.js";
import type { GuardResult } from "./request-guard.js";
import { approverAllowed } from "./approvals.js";
import { isServerScope } from "../../shared/agents/server-agent.js";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Issue 565: who a report request comes from, as drafts are matched
 * (`agent:<id>`, the bare agent id): an agent's token gives its id; a
 * claim with no agent token (the fixture person, a header) is never the
 * person, so it is named by its client; null is the person.
 */
export function reportAgentOf(
  principal: { actor: string } | null,
  actor: { client?: string; agent?: string } | null,
): string | null {
  if (principal) return principal.actor.replace(/^agent:/, "");
  if (!actor) return null;
  return (actor.agent ?? actor.client ?? "unverified").replace(/^agent:/, "");
}

export interface ReportRouteDeps {
  /**
   * Issue 1127: the listed-names check (shared/filed-text-check.ts) for a
   * report's title and body in its destination: the refusal, or null to
   * file it. The server checks public destinations and those whose
   * visibility isn't known; none given, nothing is checked.
   */
  wordsCheck?: (repo: string, texts: FiledText[]) => Promise<string | null>;
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
  /**
   * Issue 403: Hub, for a report's screenshot (report-shot-hub.ts); absent,
   * every screenshot stays here.
   */
  shotHub?: Pick<ReportShotHub, "preflight" | "upload">;
  /** Issue 403: the largest screenshot kept here (bytes; a Setting). */
  shotMaxBytes?: () => number;
  /**
   * Issue 403: whether this caller may read a kept screenshot
   * (shotReaderOf with the request's guard). Absent: nobody may.
   */
  shotReader?: (req: http.IncomingMessage) => ShotReader;
  /**
   * Issue 946: whether this filing comes from the fixture person's session
   * (its kept screenshot is marked so). Absent: never.
   */
  filedByFixture?: (req: http.IncomingMessage) => boolean;
  /**
   * Issue 415: GitHub's tokenless answer for a repo's visibility, the
   * fallback when the person's `gh` can't say ("public" or null). None:
   * not asked.
   */
  publicRepo?: PublicLookup;
  /**
   * Issue 565: the activity trail's line for a filed report: who filed it
   * (the person, or `agent:<id>` through the held `report`) and where.
   */
  audit?: (e: {
    by: string;
    repo: string;
    url: string;
    added: boolean;
  }) => void;
  /** An open issue with this title, read without a token (F5), or null. */
  searchOpen?: (
    repo: string,
    title: string,
  ) => Promise<{ number: number; url: string; title: string } | null>;
}

/** Who may read a kept screenshot (issue 403), or why not. */
export type ShotReader =
  /** fixture: the fixture person, who reads only what a fixture session filed (issue 946). */
  { ok: true; fixture?: true } | { ok: false; status: 401 | 403; who?: string };

/**
 * Issue 403: whether this request may read a kept screenshot. The route is
 * readonly, so on loopback the guard lets an anonymous request through;
 * that is never the person here (a project agent can leave its token off,
 * and report ids are in public issues). The person proves it as approvals
 * ask: their command-line token, or a signed-in browser with its CSRF
 * token and approval key (approverAllowed, "read"). This install's own
 * agent reads with its token; a project agent's token gets 403. The
 * fixture person (a test install, issue 810) reads with its session and
 * CSRF token. Anything else: 401.
 */
export function shotReaderOf(
  req: http.IncomingMessage,
  guard: GuardResult,
): ShotReader {
  if (!guard.ok) return { ok: false, status: 401 };
  const p = guard.principal;
  if (p?.kind === "agent")
    return isServerScope(p.workspace)
      ? { ok: true }
      : { ok: false, status: 403, who: p.actor };
  if (p?.kind === "person") return { ok: true };
  const browser = approverAllowed(req, guard, "read");
  if (browser.ok) return { ok: true };
  // The fixture person (a test install's live checks, issue 810) never
  // decides what waits for a person, but a read decides nothing: once its
  // session and CSRF token are proven, it is the person who runs the install.
  if (browser.code === "fixture_cannot_approve")
    return { ok: true, fixture: true };
  return { ok: false, status: 401 };
}

/**
 * The label each kind is filed with: GitHub's default labels. A repo
 * without it gets the report without a label; Den only looks labels up
 * and never makes one in someone's repo.
 */
const KIND_LABEL: Record<ReportKind, string> = {
  bug: "bug",
  idea: "enhancement",
  question: "question",
};

/** A report waiting for its person's approval in the device flow. */
interface Held {
  repo: string;
  title: string;
  body: string;
  label: string;
  addTo: number | null;
  who: string;
  draftId?: string;
  /** Issue 403: the screenshot, kept and sent only once it is filed. */
  shot?: PendingShot;
  /** Issue 403: Hub, for that screenshot. */
  shotHub?: ReportRouteDeps["shotHub"];
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
      method: "GET" | "POST" | "PATCH",
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
  // A lookup only: GitHub makes a label that is sent but missing.
  const labelled =
    h.addTo === null &&
    (
      await ctx
        .api("GET", `/repos/${h.repo}/labels/${encodeURIComponent(h.label)}`)
        .catch(() => ({ status: 0 }))
    ).status === 200;
  const r =
    h.addTo !== null
      ? await ctx.api("POST", `/repos/${h.repo}/issues/${h.addTo}/comments`, {
          body: h.body + filedLine(h.shot ?? null),
        })
      : await ctx.api("POST", `/repos/${h.repo}/issues`, {
          title: h.title,
          body: h.body + filedLine(h.shot ?? null),
          ...(labelled ? { labels: [h.label] } : {}),
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
  // Issue 403: filed, so now the screenshot: kept, then to Hub, then the
  // filed body's line updated (the issue, or the comment, by its id).
  const shot = h.shot
    ? await afterFiling(
        h.shot,
        h.repo,
        h.stateDir,
        h.shotHub,
        now(),
        async (body) => {
          const where =
            h.addTo !== null
              ? typeof r.body.id === "number"
                ? `/repos/${h.repo}/issues/comments/${r.body.id}`
                : null
              : typeof r.body.number === "number"
                ? `/repos/${h.repo}/issues/${r.body.number}`
                : null;
          if (!where) return;
          await ctx.api("PATCH", where, { body: h.body + body });
        },
      )
    : null;
  return {
    ok: {
      url: typeof r.body.html_url === "string" ? r.body.html_url : "",
      repo: h.repo,
      added: h.addTo !== null,
      ...(shot ? { shot: pageOutcome(shot) } : {}),
    },
  };
}

/** Where a report's screenshot went (issue 403). */
type ShotOutcome =
  | {
      where: "hub";
      /** The report id (Den's). */
      report: string;
      /** Hub's id, or null when Hub already held one for this report. */
      id: string | null;
      recipient: string | null;
    }
  | { where: "local"; id: string; why?: UploadWhy };

/** A send's screenshot, waiting for its report to be filed. */
interface PendingShot {
  id: string;
  png: Buffer;
  share: boolean;
  /** Issue 946: filed by the fixture person's session. */
  byFixture: boolean;
}

/** The page's view of it: Hub's recipient, or why it stayed here. */
function pageOutcome(o: ShotOutcome): Record<string, unknown> {
  return o.where === "hub"
    ? { where: "hub", recipient: o.recipient ?? "Den Hub" }
    : { where: "local", id: o.id, ...(o.why ? { why: o.why } : {}) };
}

/**
 * The issue body's screenshot line (issue 403): the tool, never a URL, a
 * path, or who Hub sends it to (that stays in Den's page and record).
 */
export function shotLine(o: ShotOutcome): string {
  return o.where === "hub"
    ? o.id
      ? `Screenshot: hub_report_screenshot ${o.id} (sent to Den Hub)`
      : `Screenshot: hub_report_screenshot for report ${o.report} (sent to Den Hub)`
    : `Screenshot: kept on the reporting install; its agent can read it with report_screenshot(${o.id})`;
}

/** Issue 957: the filed line when this send's screenshot wasn't kept. */
export const NOT_KEPT_LINE = "Screenshot: not kept on the reporting install";

/** Hub's id goes in a public issue: its own shape only. */
const HUB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Issue 403: a send's screenshot, checked before anything is filed: its
 * report id (the draft's, else a new one) and bytes. Nothing is kept or
 * sent yet. null when the send has none; a string when it isn't a PNG.
 */
function pendingShot(
  b: Record<string, unknown>,
  maxBytes: number,
  byFixture = false,
  stateDir?: string,
): PendingShot | null | string | { conflict: string } {
  if (b.shot === undefined || b.shot === null) return null;
  const png = pngOfDataUrl(b.shot, maxBytes);
  if (!png)
    return `the screenshot must be a PNG data URL of at most ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MB`;
  const id =
    typeof b.draftId === "string" && REPORT_ID.test(b.draftId)
      ? b.draftId
      : newReportId();
  // Issue 957: a filing never replaces a kept screenshot of another kind of
  // filer (the fixture person's, or anyone else's): nothing is filed.
  const kept = stateDir ? shotStore(stateDir).get(id) : null;
  if (kept && (kept.record.byFixture === true) !== byFixture)
    return {
      conflict:
        "that report id holds another filer's screenshot: send it as a new report",
    };
  return { id, png, share: b.shareShot === true, byFixture };
}

/** The line a body is filed with: kept here (true once it is filed). */
const filedLine = (p: PendingShot | null) =>
  p ? `\n\n${shotLine({ where: "local", id: p.id })}` : "";

/**
 * Issue 403: after the issue (or comment) exists. Kept here always; ticked
 * and Hub-connected, sent to Hub; when Hub has it, `update` rewrites the
 * filed body's line (given the new line block). Hub saying no is an
 * outcome, not a failure. "conflict" means Hub already holds this
 * report's screenshot: Hub's, never "stayed here".
 */
async function afterFiling(
  p: PendingShot,
  repo: string,
  stateDir: string,
  hub: ReportRouteDeps["shotHub"],
  now: number,
  update: (line: string) => Promise<void>,
): Promise<ShotOutcome | null> {
  const store = shotStore(stateDir);
  // Issue 957: checked again here, at the save. A held filing saves only
  // after the person's approval, and another kind of filer may have kept
  // a screenshot under this id meanwhile: that one stays, nothing kept.
  const kept = store.get(p.id);
  if (kept && (kept.record.byFixture === true) !== p.byFixture) {
    // The filed line named this id: it says now that none was kept, so no
    // filed issue names an id that holds another filer's screenshot.
    await update(`\n\n${NOT_KEPT_LINE}`).catch(() => undefined);
    return null;
  }
  store.save(p.id, p.png, repo, now, { byFixture: p.byFixture });
  const local = (why?: UploadWhy): ShotOutcome => ({
    where: "local",
    id: p.id,
    ...(why ? { why } : {}),
  });
  if (!p.share) return local();
  if (!hub) return local("not-connected");
  const up = await hub
    .upload(p.png, { draftId: p.id, targetRepo: repo })
    .catch(() => ({ ok: false as const, why: "unreachable" as const }));
  let o: ShotOutcome;
  if (up.ok) {
    if (!HUB_ID.test(up.id)) return local("refused");
    store.recordHub(p.id, {
      id: up.id,
      sha256: up.sha256,
      expires: up.expires,
      recipient: up.recipient,
      confirmed: up.confirmed,
    });
    o = { where: "hub", report: p.id, id: up.id, recipient: up.recipient };
  } else if (up.why === "conflict") {
    const had = store.get(p.id)?.record.hub;
    o = {
      where: "hub",
      report: p.id,
      id: had && HUB_ID.test(had.id) ? had.id : null,
      recipient: had?.recipient ?? null,
    };
  } else return local(up.why);
  await update(`\n\n${shotLine(o)}`).catch(() => undefined);
  return o;
}

/** GET /api/report/github-send/<id>. */
const FLOW_PATH = /^\/api\/report\/github-send\/([A-Za-z0-9_-]{16,64})$/;
/** GET /api/report/shots/<id> (issue 403). */
const SHOT_PATH = /^\/api\/report\/shots\/([a-f0-9]{16})$/;
/** GET and DELETE /api/report/drafts/<id>. */
const DRAFT_PATH = /^\/api\/report\/drafts\/([a-f0-9]{16})$/;

const KINDS: readonly ReportKind[] = ["bug", "idea", "question"];

/** What the client sends for a preview or a send. */
export interface Draftish {
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
export async function compose(
  b: Draftish,
  d: ReportRouteDeps,
): Promise<
  { title: string; body: string; repo: string; label: string } | string
> {
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
    label: KIND_LABEL[form.kind],
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

/** A destination's visibility as the form shows it (issue 415). */
export type DestinationVisibility = RepoVisibility | "unknown";

/**
 * Issue 415: each destination's visibility, so the form says who can see
 * it: the person's `gh` first, GitHub's tokenless answer after. Still not
 * known: "unknown", never "public" (the form then says not known, with the
 * caution). The wait is short and bounded. Issue 565: `den report` and the
 * agents' `report` show the same list and labels.
 */
export async function reportDestinations(d: ReportRouteDeps): Promise<{
  signedIn: boolean;
  repos: { repo: string; visibility: DestinationVisibility }[];
}> {
  const s = d.settings();
  const signedIn = await ghSignedIn(d);
  const vis =
    signedIn || d.publicRepo
      ? await repoVisibilities(d.stateDir(), s.repos, {
          gh: signedIn ? (a) => d.gh(a) : null,
          anon: d.publicRepo,
          ttlMs: s.visibilityCacheHours * 3_600_000,
          timeoutMs: s.visibilityTimeoutSeconds * 1000,
          retryMs: s.visibilityRetrySeconds * 1000,
          now: d.now ?? Date.now,
        })
      : {};
  return {
    signedIn,
    repos: s.repos.map((repo) => ({
      repo,
      visibility: vis[repo] ?? "unknown",
    })),
  };
}

/** What a send answers: the route's status and body. */
export interface FiledReport {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The send, as the person on GitHub (their `gh`): the page's Send and the
 * command line's (POST /api/report/send), and issue 565's held `report`
 * once the person (or the approval policy) allowed it. `who` counts for
 * the hour's limit; `by` is who filed it, for the audit.
 */
export async function fileReport(
  d: ReportRouteDeps,
  b: Draftish & Record<string, unknown>,
  who: string,
  by: string,
  // Issue 946: filed by the fixture person's session (its kept screenshot
  // is marked so, and only such a one is the fixture person's to read).
  opts: { byFixture?: boolean } = {},
): Promise<FiledReport> {
  const now = d.now ?? Date.now;
  const c = await compose(b, d);
  if (typeof c === "string")
    return { status: 400, body: { ok: false, error: c } };
  // Issue 1127: listed names, before anything is counted or sent.
  const refusal = await d.wordsCheck?.(c.repo, [
    { field: "title", text: c.title },
    { field: "body", text: c.body },
  ]);
  if (refusal)
    return { status: 400, body: { ok: false, code: "words", error: refusal } };
  const s = d.settings();
  const log = sentLog(d.stateDir());
  if (log.recent(who, now()) >= s.maxPerHour)
    return {
      status: 429,
      body: {
        ok: false,
        limit: s.maxPerHour,
        nextAt: new Date(log.nextAt(who, now())).toISOString(),
        error: `at most ${s.maxPerHour} reports an hour`,
      },
    };
  if (!(await ghSignedIn(d)))
    return {
      status: 409,
      body: {
        ok: false,
        need: "github",
        error: "sending needs a GitHub sign-in: nothing was sent",
        deviceFlow: !!d.flows,
        newIssueUrl: newIssueUrl(c.repo, c.title, c.body),
      },
    };
  const addTo = Number.isInteger(b.addTo) ? (b.addTo as number) : null;
  if (addTo === null && b.fileNew !== true) {
    const dup = await sameTitle(d, c.repo, c.title);
    if (dup) return { status: 409, body: { ok: false, duplicate: dup } };
  }
  const pending = pendingShot(
    b,
    d.shotMaxBytes?.() ?? MAX_KEPT_BYTES,
    opts.byFixture === true,
    d.stateDir(),
  );
  if (typeof pending === "string")
    return { status: 400, body: { ok: false, error: pending } };
  if (pending && "conflict" in pending)
    return { status: 409, body: { ok: false, error: pending.conflict } };
  const body = c.body + filedLine(pending);
  const r =
    addTo !== null
      ? await d.gh(
          ["issue", "comment", String(addTo), "-R", c.repo, "--body-file", "-"],
          body,
        )
      : await d.gh(
          [
            "issue",
            "create",
            "-R",
            c.repo,
            "--title",
            c.title,
            ...((await hasLabel(d, c.repo, c.label))
              ? ["--label", c.label]
              : []),
            "--body-file",
            "-",
          ],
          body,
        );
  if (r.code !== 0)
    return {
      status: 502,
      body: {
        ok: false,
        error: `GitHub refused it: ${(r.stderr || r.stdout).trim().split("\n")[0] || `gh exited ${r.code}`}`,
        // Nothing was kept or sent: the tab's issue has no screenshot line.
        newIssueUrl: newIssueUrl(c.repo, c.title, c.body),
      },
    };
  log.add(who, now());
  if (typeof b.draftId === "string") draftStore(d.stateDir()).remove(b.draftId);
  const url = r.stdout.trim().split("\n").pop() ?? "";
  // Issue 565: who filed it and where it went, in the activity trail.
  try {
    d.audit?.({ by, repo: c.repo, url, added: addTo !== null });
  } catch {
    /* the trail is best effort: the issue is filed */
  }
  // Issue 403: filed, so now the screenshot (kept, to Hub, line updated).
  const shot = pending
    ? await afterFiling(
        pending,
        c.repo,
        d.stateDir(),
        d.shotHub,
        now(),
        async (line) => {
          const issue = /\/issues\/(\d+)$/.exec(url)?.[1];
          const comment = /#issuecomment-(\d+)$/.exec(url)?.[1];
          if (addTo !== null && comment)
            await d.gh(
              [
                "api",
                "-X",
                "PATCH",
                `repos/${c.repo}/issues/comments/${comment}`,
                "--input",
                "-",
              ],
              JSON.stringify({ body: c.body + line }),
            );
          else if (addTo === null && issue)
            await d.gh(
              ["issue", "edit", issue, "-R", c.repo, "--body-file", "-"],
              c.body + line,
            );
        },
      )
    : null;
  return {
    status: 200,
    body: {
      ok: true,
      url,
      repo: c.repo,
      added: addTo !== null,
      ...(shot ? { shot: pageOutcome(shot) } : {}),
    },
  };
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

/** Whether `repo` has `label` (read only: a missing one is never made). */
async function hasLabel(
  d: ReportRouteDeps,
  repo: string,
  label: string,
): Promise<boolean> {
  try {
    return (
      (await d.gh(["api", `repos/${repo}/labels/${encodeURIComponent(label)}`]))
        .code === 0
    );
  } catch {
    return false;
  }
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
      const { signedIn, repos } = await reportDestinations(d);
      d.sendJson(res, {
        ok: true,
        enabled: s.enabled,
        repos,
        github: { signedIn, deviceFlow: !!d.flows },
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
            error:
              "only a person sends a report here; an agent asks with `report` (a held write the person allows)",
          },
          403,
        );
      const b = await json();
      // Issue 565: one send for the page, the command line and the held
      // `report` an agent asks for.
      const r = await fileReport(d, b, d.personOf(req), "person", {
        byFixture: d.filedByFixture?.(req) === true,
      });
      d.sendJson(res, r.body, r.status);
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
      // Issue 403: held with the report; nothing kept or sent before the
      // person approves and GitHub files it (decideReport).
      const pending = pendingShot(
        b,
        d.shotMaxBytes?.() ?? MAX_KEPT_BYTES,
        d.filedByFixture?.(req) === true,
        d.stateDir(),
      );
      if (typeof pending === "string")
        return d.sendJson(res, { ok: false, error: pending }, 400);
      if (pending && "conflict" in pending)
        return d.sendJson(res, { ok: false, error: pending.conflict }, 409);
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
        ...(pending ? { shot: pending, shotHub: d.shotHub } : {}),
        label: c.label,
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

  if (pathname === "/api/report/shot-share" && req.method === "GET")
    return run(async () => {
      if (!d.settings().enabled) return off();
      const repo =
        new URL(req.url ?? "/", "http://den.invalid").searchParams.get(
          "repo",
        ) ?? "";
      if (!d.settings().repos.includes(repo))
        return d.sendJson(
          res,
          { ok: false, error: "no such destination" },
          400,
        );
      const p = d.shotHub ? await d.shotHub.preflight(repo) : null;
      d.sendJson(
        res,
        p?.ok && p.share
          ? { ok: true, share: true, recipient: p.recipient }
          : { ok: true, share: false },
      );
    });

  const sm = SHOT_PATH.exec(pathname);
  if (sm && req.method === "GET")
    return run(async () => {
      const who: ShotReader = d.shotReader
        ? d.shotReader(req)
        : { ok: false, status: 401 };
      if (!who.ok)
        return d.sendJson(
          res,
          {
            ok: false,
            error:
              who.status === 403
                ? `a report's screenshot is read by the person who runs this install, or by this install's own agent; ${who.who ?? "this agent"} is neither. Ask that agent for report_screenshot(${sm[1]}).`
                : `a report's screenshot needs the person who runs this install: sign in on this page, or use your command-line token. Or ask this install's own agent for report_screenshot(${sm[1]}).`,
          },
          who.status,
        );
      const kept = shotStore(d.stateDir()).get(sm[1]!);
      // Issue 946: the fixture person sees only what a fixture session
      // filed; anything else answers as if none were kept.
      const got = kept && (!who.fixture || kept.record.byFixture) ? kept : null;
      if (!got)
        return d.sendJson(
          res,
          {
            ok: false,
            error:
              "no screenshot is kept for that report (none, or past its days)",
          },
          404,
        );
      d.sendJson(res, {
        ok: true,
        id: got.record.id,
        repo: got.record.repo,
        savedAt: got.record.savedAt,
        ...(got.record.hub ? { hub: got.record.hub } : {}),
        mime: "image/png",
        base64: got.png.toString("base64"),
      });
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
        // An agent's draft is always scrubbed: it can't turn that off.
        redact: agent ? true : b.redact !== false,
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
