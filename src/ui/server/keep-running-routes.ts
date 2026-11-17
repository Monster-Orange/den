/**
 * Issue 163: Settings › Keep agents running after logout › Apply.
 *
 *   POST /api/keep-running-after-logout {on}   a person's only. Saves the Setting
 *        (agents.keep_running_after_logout) and re-installs Den's launchd
 *        jobs in its mode through `service install --mode <m>` (cmdService,
 *        handed off: install.sh runs detached, since it replaces the job
 *        this server runs in). on: always (LaunchDaemons running as the
 *        person); off: login (LaunchAgents).
 *
 * The admin password is for sudo only (LK-0, R8), asked only when sudo
 * will run: for always, and to remove the LaunchDaemons a login install
 * replaces. Then, with no password held and no passwordless sudo, the
 * answer is `needsSudo` (the page asks, as for any run, then applies
 * again) and nothing is saved or run. Never for login over login.
 *
 * Answers:
 *   { ok: false, needsSudo: { command } }      ask, then Apply again
 *   { ok: true, applied: true, mode }           re-installing; Den restarts
 *   { ok: true, applied: false, mode, message } saved; nothing to re-install
 *
 * An install that fails to start puts the Setting back (500); install.sh
 * itself asks sudo once before it changes anything, so a refusal there
 * leaves the old mode too.
 */
import * as fs from "fs";
import type * as http from "http";
import * as path from "path";
import type { ServiceMode } from "../cli/doctor-where.js";

export interface KeepRunningDeps {
  /** An agent's request (its token or actor header): never applies it. */
  isAgent: (req: http.IncomingMessage) => boolean;
  platform: () => NodeJS.Platform;
  /** The mode of the installed web job, or null when Den isn't a service. */
  installed: () => ServiceMode | null;
  /** A password is held, or sudo needs none (sudo-store.ts). */
  sudoReady: () => boolean;
  /** The Setting as it is now (undefined: unset), to put it back. */
  current?: () => boolean | undefined;
  /** Write agents.keep_running_after_logout (null clears it). */
  save: (on: boolean | null) => void;
  /** `service install --mode <m>`, handed off: 0 once it started. */
  install: (mode: ServiceMode) => Promise<number>;
  /** The CLI's name, for the command line it names. */
  cli: string;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

/** Whether `service install` into `mode` over `installed` runs sudo. */
export function installRunsSudo(
  mode: ServiceMode,
  installed: ServiceMode | null,
): boolean {
  return mode === "always" || installed === "always";
}

export function handleKeepRunningRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: KeepRunningDeps,
): boolean {
  if (pathname !== "/api/keep-running-after-logout" || req.method !== "POST")
    return false;
  void (async () => {
    if (d.isAgent(req))
      return d.sendJson(
        res,
        { ok: false, error: "only a person changes how Den runs" },
        403,
      );
    let body: { on?: unknown };
    try {
      body = JSON.parse(await d.readBody(req)) as { on?: unknown };
    } catch {
      return d.sendJson(res, { ok: false, error: "not JSON" }, 400);
    }
    if (typeof body.on !== "boolean")
      return d.sendJson(res, { ok: false, error: "on is true or false" }, 400);
    if (d.platform() !== "darwin")
      return d.sendJson(
        res,
        {
          ok: false,
          error: "keeping agents running after logout is for macOS (launchd)",
        },
        409,
      );
    const on = body.on;
    const mode: ServiceMode = on ? "always" : "login";
    const installed = d.installed();
    const command = `${d.cli} service install --mode ${mode}`;
    if (installed === null) {
      d.save(on);
      return d.sendJson(res, {
        ok: true,
        applied: false,
        mode,
        message: `Saved. Den isn't running as a service yet: ${command} applies it.`,
      });
    }
    if (installed === mode) {
      d.save(on);
      return d.sendJson(res, {
        ok: true,
        applied: false,
        mode,
        message: "Saved. Den already runs this way.",
      });
    }
    if (installRunsSudo(mode, installed) && !d.sudoReady())
      return d.sendJson(res, { ok: false, needsSudo: { command } });
    const before = d.current?.();
    d.save(on);
    let code: number;
    try {
      code = await d.install(mode);
    } catch (e) {
      d.save(before ?? null);
      return d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    }
    if (code !== 0) {
      d.save(before ?? null);
      return d.sendJson(
        res,
        {
          ok: false,
          error: `${command} did not start (exit ${code}). Nothing changed.`,
        },
        500,
      );
    }
    return d.sendJson(res, { ok: true, applied: true, mode });
  })().catch((e) => {
    if (!res.headersSent)
      d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
  });
  return true;
}

/** Issue 163 (a): the offer is made once per install: this file says it was. */
export const KEEP_OFFER_FILE = "keep-running-offer.json";

/**
 * Issue 163 (a): an install from before Keep agents running after logout
 * was on by default (a login service, the Setting never set) is not
 * switched silently, since that needs sudo. Its web server offers it once:
 * one bell note, "Keep agents running after logout: Apply", that opens the
 * Setting. True when it was added now.
 */
export function noteKeepRunningOffer(
  store: Pick<import("../../shared/notifications.js").NotificationStore, "add">,
  stateDir: string,
  d: {
    installed: () => ServiceMode | null;
    keep: () => boolean | undefined;
  },
): boolean {
  if (d.installed() !== "login") return false;
  let keep: boolean | undefined;
  try {
    keep = d.keep();
  } catch {
    return false;
  }
  if (keep !== undefined) return false;
  const file = path.join(stateDir, KEEP_OFFER_FILE);
  if (fs.existsSync(file)) return false;
  store.add({
    kind: "service",
    subject: "record:keep-running-offer",
    scope: "workspace/den-server",
    text: "Keep agents running after logout: Apply",
    msg: { key: "bell.m.keepOffer", vars: {} },
    link: "/settings#agents.keep_running",
  });
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify({ offeredAt: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* offered again next start: better than never */
  }
  return true;
}

/**
 * #299 (inside #163): Settings › Keep agents running after logout ›
 * Sign-in token.
 *
 *   DELETE /api/agents/signin-token         removes it the way it was kept
 *                                           (a person's only; 409 with no
 *                                           secrets store)
 *   POST /api/agents/signin-token {token}   a person's only (an agent's
 *        request is refused, as `agents token set` refuses in an agent's
 *        session). Writes the token to the install's configured secrets
 *        store by the same code as `agents token set` (saveAgentToken).
 *
 * The token is never in an answer, a log line or an error: the answer is
 * where it went and the row's state (set <date> or missing).
 *
 * Answers:
 *   { ok: true, store, signin }   saved
 *   { ok: false, error }          400 not a token, 403 an agent, 500 the store
 */
export interface SignInTokenDeps {
  isAgent: (req: http.IncomingMessage) => boolean;
  /** saveAgentToken into the configured store. */
  save: (token: string) => Promise<{ ref: string; store: string }>;
  /** clearAgentToken: removes it the way it was kept (DELETE). */
  clear?: () => Promise<{ cleared: boolean; store?: string }>;
  /** The Settings row's agent_signin (never the token). */
  status: () => unknown | Promise<unknown>;
  /** A line for the server's log (never the token). */
  log?: (line: string) => void;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

/** The 4xx code for a secrets config gap, or null for a real failure. */
function configGapCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  if (code === "no_secrets_store") return "no_secrets_store";
  if (code === "not-configured") return "secrets_not_configured";
  return null;
}

export function handleSignInTokenRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: SignInTokenDeps,
): boolean {
  if (pathname !== "/api/agents/signin-token") return false;
  if (req.method === "DELETE" && d.clear) {
    const clear = d.clear;
    void (async () => {
      if (d.isAgent(req))
        return d.sendJson(
          res,
          {
            ok: false,
            error: "only a person removes the agents' sign-in token",
          },
          403,
        );
      let r: { cleared: boolean; store?: string };
      try {
        r = await clear();
      } catch (e) {
        const error =
          String((e as Error)?.message ?? e).trim() ||
          "the secrets store refused it";
        const gap = configGapCode(e);
        return d.sendJson(
          res,
          gap ? { ok: false, code: gap, error } : { ok: false, error },
          gap ? 409 : 500,
        );
      }
      if (r.cleared)
        d.log?.(`agents' sign-in token removed from ${r.store} (by a person)`);
      return d.sendJson(res, {
        ok: true,
        cleared: r.cleared,
        signin: await d.status(),
      });
    })().catch(() => {
      if (!res.headersSent)
        d.sendJson(res, { ok: false, error: "not removed" }, 500);
    });
    return true;
  }
  if (req.method !== "POST") return false;
  void (async () => {
    if (d.isAgent(req))
      return d.sendJson(
        res,
        {
          ok: false,
          error: "only a person sets the agents' sign-in token",
        },
        403,
      );
    let token: unknown;
    try {
      token = (JSON.parse(await d.readBody(req)) as { token?: unknown })?.token;
    } catch {
      return d.sendJson(res, { ok: false, error: "not JSON" }, 400);
    }
    if (typeof token !== "string")
      return d.sendJson(res, { ok: false, error: "token is a string" }, 400);
    const { tokenShapeError, withoutSecret } =
      await import("../../shared/agents/signin-token.js");
    const bad = tokenShapeError(token);
    if (bad) return d.sendJson(res, { ok: false, error: bad }, 400);
    const value = token.trim();
    let saved: { store: string };
    try {
      saved = await d.save(value);
    } catch (e) {
      const error =
        withoutSecret(String((e as Error)?.message ?? e), value) ||
        "the secrets store refused it";
      // A config gap (no store, or one that keeps nothing) is the person's
      // to fix, not a server error.
      const gap = configGapCode(e);
      return d.sendJson(
        res,
        gap ? { ok: false, code: gap, error } : { ok: false, error },
        gap ? 409 : 500,
      );
    }
    d.log?.(`agents' sign-in token saved in ${saved.store} (by a person)`);
    return d.sendJson(res, {
      ok: true,
      store: saved.store,
      signin: await d.status(),
    });
  })().catch(() => {
    if (!res.headersSent)
      d.sendJson(res, { ok: false, error: "not saved" }, 500);
  });
  return true;
}
