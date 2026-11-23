/**
 * Issue 868: the sign-in page's fix for an install with no GitHub sign-in
 * client, instead of "edit a file on the host and restart":
 *
 *   POST /api/signin/github-setup   from the signed-out page (sign-in free,
 *        an allowed Origin, as /api/signin/code). Holds one request,
 *        github_signin_setup, for a person signed in to THIS Den to Allow
 *        in their approval dialog. One waits at a time: asking again while
 *        it waits answers the same. Refused once a client id is set. The
 *        asker gets no id or ticket: nothing to read or decide.
 *
 * The held write github_signin_setup: Den's own Allow dialog, the person's
 * own Allow only (CRITICAL_HELD_ACTIONS: it changes how people sign in).
 * Approving it is approval-routes.ts's decide: a signed-in browser of this
 * Den holding its approval key. A person signed in to another Den on the
 * same host is a separate trust domain and can't (their session isn't one
 * this Den issued). Run: sets web.github_client_id to Den's own GitHub App
 * (its public client id) in the person's config, then restarts Den, which
 * reads it at start.
 */
import type * as http from "http";
import { line, reviewLines } from "../../shared/review-lines.js";
import type { HeldAction, HeldCheck } from "./approval-routes.js";
import type { ApprovalQueue, AskedBy } from "./approvals.js";

export const GITHUB_SETUP_ACTION = "github_signin_setup";
export const GITHUB_SETUP_PATH = "/api/signin/github-setup";
/** Who asked, on the request: the signed-out page (no identity). */
export const SIGNIN_PAGE_ACTOR = "signin-page";

export interface GithubSetupDeps {
  /** Sign in with GitHub's state now (index.ts githubSignin). */
  state: () => "ready" | "claim" | "no_client_id" | "no_owner";
  /** The setting and file it is written to, for the Review. */
  setting: string;
  file: string;
  /** Write web.github_client_id (Den's own app) into the person's config. */
  enable: () => void;
  /** Den's restart (den_restart's run): it reads the setting at start. */
  restart: (
    reason: string,
    asked?: AskedBy,
  ) => Promise<{ ok: boolean; restarting?: boolean; error?: string }>;
}

export function githubSetupHeld(d: GithubSetupDeps): HeldAction {
  return {
    check(): HeldCheck {
      if (d.state() !== "no_client_id")
        return {
          ok: false,
          error: "Sign in with GitHub already has a client id on this Den",
        };
      return {
        ok: true,
        personOnly: true,
        args: {},
        summary: "turn on Sign in with GitHub",
        params: {},
        ...reviewLines([
          line(
            `Sets ${d.setting} to Den's own GitHub App (its public client id) in ${d.file}.`,
            "ap.det.github_signin_setup.set",
            { setting: d.setting, file: d.file },
          ),
          line(
            "Den restarts; agents and terminals carry on where they were.",
            "ap.det.github_signin_setup.restart",
          ),
          line(
            "Then Sign in with GitHub shows on the sign-in page, from any computer.",
            "ap.det.github_signin_setup.then",
          ),
        ]),
      };
    },
    async run(_a, asked) {
      if (d.state() !== "no_client_id") return { ok: true, already: true };
      try {
        d.enable();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      return d.restart(
        "turn on Sign in with GitHub (the sign-in page's ask)",
        asked,
      );
    },
  };
}

export interface GithubSetupRouteDeps {
  queue: ApprovalQueue;
  action: HeldAction | undefined;
  /** The bell and dialogs follow the queue (approval-routes.ts changed). */
  changed?: () => void;
  audit?: (req: http.IncomingMessage, detail: string, refused?: string) => void;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  /**
   * After a Deny, how long the page's ask is refused
   * (web.signin_ask_cooldown_minutes, at most 60: the queue keeps a decided
   * request that long). Anyone who reaches the signed-out page can ask, so
   * a Deny is not undone by asking again at once. Unset: no cooldown.
   */
  cooldownMs?: () => number;
  now?: () => number;
  /**
   * The asker's network address (the one the edge vouches for, else the
   * TCP peer), so the person can tell their own browser from another's.
   */
  askerAddress?: (req: http.IncomingMessage) => string | undefined;
}

/** POST /api/signin/github-setup; false for any other path. */
export async function handleGithubSetupAsk(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GithubSetupRouteDeps,
): Promise<boolean> {
  if (pathname !== GITHUB_SETUP_PATH) return false;
  res.setHeader("Cache-Control", "no-store");
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return true;
  }
  const waiting = d.queue
    .pending()
    .find(
      (a) => a.action === GITHUB_SETUP_ACTION && a.actor === SIGNIN_PAGE_ACTOR,
    );
  if (waiting) {
    d.sendJson(res, { ok: true, state: "pending", again: true }, 202);
    return true;
  }
  const cooldown = d.cooldownMs?.() ?? 0;
  if (cooldown > 0) {
    const deniedAt = Math.max(
      0,
      ...d.queue
        .ofActor(SIGNIN_PAGE_ACTOR)
        .filter((a) => a.action === GITHUB_SETUP_ACTION && a.state === "denied")
        .map((a) => a.decidedAt ?? 0),
    );
    const left = deniedAt + cooldown - (d.now ?? Date.now)();
    if (deniedAt > 0 && left > 0) {
      const retryAfterSeconds = Math.ceil(left / 1000);
      d.audit?.(req, GITHUB_SETUP_ACTION, "asked recently (after a Deny)");
      res.setHeader("Retry-After", String(retryAfterSeconds));
      d.sendJson(
        res,
        {
          ok: false,
          code: "asked_recently",
          error: "asked recently; try again later",
          retryAfterSeconds,
        },
        429,
      );
      return true;
    }
  }
  const checked = d.action
    ? await d.action.check({})
    : ({
        ok: false,
        error: "this Den can't set up GitHub sign-in here",
      } as const);
  if (!checked.ok) {
    d.audit?.(req, GITHUB_SETUP_ACTION, checked.error);
    d.sendJson(
      res,
      { ok: false, code: "not_offered", error: checked.error },
      409,
    );
    return true;
  }
  const address = d.askerAddress?.(req);
  // The asker's address, so the person can tell whose browser asked.
  const from = address
    ? reviewLines([
        line(`Asked from ${address}.`, "ap.det.github_signin_setup.from", {
          address,
        }),
      ])
    : { details: [], detailKeys: [] };
  const details = [...(checked.details ?? []), ...from.details];
  const detailKeys = [...(checked.detailKeys ?? []), ...from.detailKeys];
  try {
    const a = d.queue.request({
      actor: SIGNIN_PAGE_ACTOR,
      via: "signin-page",
      action: GITHUB_SETUP_ACTION,
      args: checked.args,
      summary: checked.summary,
      params: checked.params,
      details,
      ...(detailKeys.length ? { detailKeys } : {}),
    });
    d.audit?.(req, `${GITHUB_SETUP_ACTION}: ${a.summary} [${a.id}]`);
  } catch (e) {
    d.sendJson(
      res,
      { ok: false, code: "too_many_waiting", error: (e as Error).message },
      429,
    );
    return true;
  }
  try {
    d.changed?.();
  } catch {
    /* the bell is best effort: the dialog polls the queue */
  }
  d.sendJson(res, { ok: true, state: "pending" }, 202);
  return true;
}
