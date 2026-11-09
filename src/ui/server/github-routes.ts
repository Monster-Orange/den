/**
 * SEC-2a's routes: Sign in with GitHub (the signed-out page), the owner's
 * link (Settings › Access, `web owner …`), and Pair a device.
 *
 *   POST /api/github/signin            start a sign-in (sign-in free; an
 *                                      allowed Origin, no CSRF token)
 *   GET  /api/github/signin/<id>       its outcome; approved by the owner:
 *                                      the session cookie, once
 *   GET  /api/web/owner                who the owner is
 *   POST /api/web/owner/link           start linking the owner (shell-grade)
 *   GET  /api/web/owner/link/<id>      its code and outcome
 *   POST /api/web/owner/unlink         unlink the owner (shell-grade)
 *   GET  /api/web/pair                 the edge hostnames a link can be for
 *   POST /api/web/pair { host }        a one-time sign-in link for one
 *
 * The token GitHub hands back is used once, for `GET /user`, and dropped
 * (device-flows.ts). Nothing here logs a code, a token or a cookie.
 */
import type * as http from "http";
import { githubPrincipal } from "../../shared/github-device.js";
import {
  clearWebOwner,
  readWebOwner,
  writeWebOwner,
} from "../../shared/web-owner.js";
import type {
  Decide,
  Decision,
  DeviceFlows,
  FlowView,
} from "./device-flows.js";

/**
 * D17: who may claim a Den that has no owner yet.
 *  - `ownerGithub` (web.owner_github, recorded from `gh` where the
 *    instance was started): that login, from any machine.
 *  - `allowedGithubOrg` (web.allowed_github_org, the distribution's): a
 *    member of the org, only with this machine's proof (a session, which
 *    on a fresh Den only "This is my computer" or a terminal gives): the
 *    owner link, never the signed-out sign-in.
 * Anyone else is refused, with why. Neither set: nobody claims from the
 * browser; the page names the settings.
 */
export interface ClaimRules {
  ownerGithub?: string;
  allowedGithubOrg?: string;
  /** The file web.allowed_github_org is in (for the messages). */
  allowedGithubOrgFile?: string;
}

const sameLogin = (a: string, b: string | undefined) =>
  !!b && a.toLowerCase() === b.toLowerCase();

/** Why a signed-out GitHub sign-in can't claim a Den with no owner. */
export function unclaimedSigninReason(
  login: string | null,
  r: ClaimRules,
): string {
  const who = login ? `@${login}` : "This account";
  if (r.allowedGithubOrg)
    return (
      `${who} can't claim this Den from here: it has no owner yet. ` +
      `A member of the ${r.allowedGithubOrg} GitHub org claims it on the computer it runs on: ` +
      `open this page there and choose This is my computer.` +
      (r.ownerGithub
        ? ` From another computer, only @${r.ownerGithub} (web.owner_github) can.`
        : "")
    );
  if (r.ownerGithub)
    return `${who} isn't the account this Den was started by (@${r.ownerGithub}, web.owner_github). Sign in as @${r.ownerGithub}.`;
  return noRuleMessage(r);
}

/** Neither rule is set: the settings that would let someone claim it. */
export function noRuleMessage(r: ClaimRules): string {
  return (
    "This Den has no owner yet, and nothing says who may claim it. " +
    `Set web.allowed_github_org (your GitHub org) in ${r.allowedGithubOrgFile ?? "the distribution config"}, ` +
    "or web.owner_github (your GitHub login) in config/local/user.yml on the computer it runs on."
  );
}

export interface GithubRouteDeps {
  flows: DeviceFlows;
  /** The configured client id ("" when none). */
  clientId: () => string;
  /** The app issued an expiring token (its token expiry is on): a misconfiguration. */
  tokensExpire?: () => boolean;
  cli: string;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /** A new browser session for this request: its Set-Cookie line and approval key. */
  signIn: (
    req: http.IncomingMessage,
    via: "github" | "link",
    login?: string,
  ) => { cookie: string; approveKey: string };
  /** The edge hostnames that route here, and the URL a browser uses for each. */
  edgeRoutes: () => { host: string; url: string }[];
  /** A one-time sign-in link at `origin` (60 s), or null with no secret. */
  mintLink: (origin: string) => { url: string; expiresAt: number } | null;
  log: (line: string) => void;
  /** Where the owner file lives (the server's state dir). */
  stateDir: () => string;
  /** D17: who may claim a Den with no owner (read now). */
  claimRules?: () => ClaimRules;
  /**
   * D17: spend a "This is my computer" code (attest-code.ts) for this
   * request's host: true once, for a valid one.
   */
  spendAttest?: (req: http.IncomingMessage, code: string) => boolean;
}

const SIGNIN_PATH = /^\/api\/github\/signin\/([A-Za-z0-9_-]{16,64})$/;
const LINK_PATH = /^\/api\/web\/owner\/link\/([A-Za-z0-9_-]{16,64})$/;

/**
 * What an identity means for a flow: the owner's sign-in, or the owner's
 * link; with no owner yet, a claim by ClaimRules (D17).
 */
export function decideFlow(
  stateDir: () => string,
  log: (line: string) => void,
  rules: () => ClaimRules = () => ({}),
): Decide {
  /** Link `identity` as the owner unless one appeared meanwhile. */
  const claim = (
    identity: { id: number; login: string },
    how: string,
  ): "ok" | "refused" => {
    const now = readWebOwner(stateDir());
    if (now)
      return now.owner === githubPrincipal(identity.id) ? "ok" : "refused";
    writeWebOwner(identity, stateDir());
    log(`  ✓ owner linked: @${identity.login} (${how})`);
    return "ok";
  };
  /** A member of `org` claims it; anyone else is refused, with why. */
  const memberClaim = async (
    identity: { id: number; login: string },
    org: string,
    ctx: { orgMember(org: string): Promise<string> },
  ): Promise<Decision> => {
    const m = await ctx.orgMember(org);
    if (m === "member") return claim(identity, `member of ${org}`);
    log(
      `  ✗ owner claim refused: @${identity.login} ${m === "not_member" ? "isn't a member of" : "has no readable membership in"} ${org}`,
    );
    return {
      refused:
        m === "not_member"
          ? `@${identity.login} isn't a member of the ${org} GitHub org (web.allowed_github_org), so it can't own this Den.`
          : `Den couldn't tell whether @${identity.login} is a member of ${org}: the membership is private, and the GitHub App can't read it. ` +
            `Either make your membership public (github.com/orgs/${org}/people), or have an ${org} org admin grant the GitHub App Members (read) access. ` +
            `Or set web.owner_github: ${identity.login} in config/local/user.yml on this computer (\`gh auth login\` before \`web up\` does it for you).`,
    };
  };
  return async (purpose, identity, ctx) => {
    const owner = readWebOwner(stateDir());
    const r = rules();
    const named = sameLogin(identity.login, r.ownerGithub);
    if (purpose === "signin") {
      if (!owner) {
        // D17: the login web.owner_github names claims it from anywhere;
        // a member of the org, only with this machine's proof.
        if (named) return claim(identity, "web.owner_github");
        if (r.allowedGithubOrg && ctx.local)
          return memberClaim(identity, r.allowedGithubOrg, ctx);
        log(
          `  ✗ GitHub sign-in refused: @${identity.login} can't claim this Den (no owner yet)`,
        );
        return { refused: unclaimedSigninReason(identity.login, r) };
      }
      const ok = owner.owner === githubPrincipal(identity.id);
      log(
        ok
          ? `  ✓ signed in with GitHub (@${identity.login})`
          : `  ✗ GitHub sign-in refused: @${identity.login} isn't this Den's owner`,
      );
      return ok ? "ok" : "refused";
    }
    if (owner) return "refused";
    // The link: a signed-in session (this machine's proof on a fresh Den).
    if (named) return claim(identity, "web.owner_github");
    if (r.allowedGithubOrg)
      return memberClaim(identity, r.allowedGithubOrg, ctx);
    if (r.ownerGithub) {
      log(
        `  ✗ owner link refused: @${identity.login} isn't web.owner_github (@${r.ownerGithub})`,
      );
      return {
        refused: `@${identity.login} isn't the account this Den was started by (@${r.ownerGithub}, web.owner_github). Link @${r.ownerGithub}, or change web.owner_github in config/local/user.yml.`,
      };
    }
    return claim(identity, "linked in Settings");
  };
}

/** A flow as the page sees it: the code and where to enter it, while it waits. */
function flowJson(v: FlowView): Record<string, unknown> {
  return {
    id: v.id,
    state: v.state,
    ...(v.state === "pending"
      ? {
          userCode: v.userCode,
          verificationUri: v.verificationUri,
          expiresAt: new Date(v.expiresAt).toISOString(),
        }
      : {}),
    ...(v.login ? { login: v.login } : {}),
  };
}

function finishedMessage(v: FlowView, cli: string): string | undefined {
  switch (v.state) {
    case "refused":
      if (v.message) return v.message;
      return v.purpose === "signin"
        ? `@${v.login} isn't the owner of this Den. Only the owner's account can use Sign in with GitHub. Use Approve this computer instead.`
        : `An owner is linked already; \`${cli} web owner unlink\` first.`;
    case "expired":
      return "The code expired before it was approved. Start again.";
    case "denied":
      return "The request was cancelled on GitHub.";
    case "error":
      return v.message ?? "GitHub couldn't be reached.";
    default:
      return undefined;
  }
}

async function startFlow(
  deps: GithubRouteDeps,
  res: http.ServerResponse,
  purpose: "signin" | "link",
  meta: { local?: boolean } = {},
): Promise<void> {
  let r;
  try {
    r = await deps.flows.start(purpose, meta);
  } catch (e) {
    return deps.sendJson(
      res,
      { ok: false, code: "github_unreachable", error: (e as Error).message },
      502,
    );
  }
  if ("error" in r)
    return r.error === "busy"
      ? deps.sendJson(
          res,
          {
            ok: false,
            code: "busy",
            error:
              "Too many GitHub sign-ins are in progress. Try again in a few minutes.",
          },
          429,
        )
      : deps.sendJson(
          res,
          {
            ok: false,
            code: "no_client_id",
            error: `Sign in with GitHub needs a GitHub App client id: set web.github_client_id in config/local/user.yml and restart (\`${deps.cli} web restart\`).`,
          },
          409,
        );
  return deps.sendJson(res, { ok: true, ...flowJson(r) });
}

/** Whether `pathname` is one of these routes' (index.ts dispatches them here). */
export function isGithubRoute(pathname: string): boolean {
  return /^\/api\/(github\/|web\/owner(\/|$)|web\/pair$)/.test(pathname);
}

/** Handles a SEC-2a route; false when `pathname` is none of them. */
export async function handleGithubRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: GithubRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");

  // ── Sign in with GitHub ──────────────────────────────────────────────
  if (pathname === "/api/github/signin" && method === "POST") {
    // D17: "This is my computer"'s code, if the page has one (the body's
    // `attest`): spent here, once, for this host.
    let body: { attest?: unknown } = {};
    try {
      body = (JSON.parse((await deps.readBody(req)) || "{}") ??
        {}) as typeof body;
    } catch {
      body = {};
    }
    const attest = typeof body.attest === "string" ? body.attest : "";
    const local = !!attest && !!deps.spendAttest?.(req, attest);
    if (attest && !local) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "attest_failed",
          error:
            "This browser isn't on the computer this Den runs on, or its proof expired. Try This is my computer again, on that computer.",
        },
        403,
      );
      return true;
    }
    // D17: with no owner, web.owner_github's login may claim it from
    // anywhere; a member of web.allowed_github_org, with this machine's proof.
    const rules = deps.claimRules?.() ?? {};
    if (
      !readWebOwner(deps.stateDir()) &&
      !rules.ownerGithub &&
      !(local && rules.allowedGithubOrg)
    ) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: rules.allowedGithubOrg ? "claim_here" : "no_owner",
          error: rules.allowedGithubOrg
            ? unclaimedSigninReason(null, rules)
            : `${noRuleMessage(rules)} Or, on that computer, run \`${deps.cli} web owner link\`.`,
        },
        409,
      );
      return true;
    }
    await startFlow(deps, res, "signin", { local });
    return true;
  }
  const s = SIGNIN_PATH.exec(pathname);
  if (s && (method === "GET" || method === "HEAD")) {
    const v = deps.flows.get(s[1], "signin");
    if (!v) {
      deps.sendJson(
        res,
        {
          ok: false,
          state: "gone",
          code: "not_found",
          error: "That sign-in ended. Start again.",
        },
        404,
      );
      return true;
    }
    if (v.state === "ok") {
      if (!deps.flows.claim(v.id, "signin")) {
        deps.sendJson(res, { ok: false, state: "gone" }, 404);
        return true;
      }
      const s = deps.signIn(req, "github", v.login);
      res.setHeader("Set-Cookie", s.cookie);
      res.setHeader("Cache-Control", "no-store");
      // The approval key goes to this answer only (web-session.ts).
      deps.sendJson(res, {
        ok: true,
        state: "ok",
        login: v.login,
        approveKey: s.approveKey,
      });
      return true;
    }
    const message = finishedMessage(v, deps.cli);
    deps.sendJson(res, {
      ok: v.state === "pending",
      ...flowJson(v),
      ...(message ? { error: message } : {}),
    });
    return true;
  }

  // ── The owner ────────────────────────────────────────────────────────
  if (pathname === "/api/web/owner" && method === "GET") {
    const o = readWebOwner(deps.stateDir());
    deps.sendJson(res, {
      owner: o ? { id: o.owner, login: o.login, linkedAt: o.linkedAt } : null,
      clientId: deps.clientId() !== "",
      // The app's "Expire user authorization tokens" is on (seen since start).
      tokenExpiry: deps.tokensExpire?.() ?? false,
    });
    return true;
  }
  if (pathname === "/api/web/owner/link" && method === "POST") {
    const o = readWebOwner(deps.stateDir());
    if (o) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "already_linked",
          error: `This Den's owner is @${o.login} already; unlink first (\`${deps.cli} web owner unlink\`).`,
        },
        409,
      );
      return true;
    }
    await startFlow(deps, res, "link");
    return true;
  }
  const l = LINK_PATH.exec(pathname);
  if (l && (method === "GET" || method === "HEAD")) {
    const v = deps.flows.get(l[1], "link");
    if (!v) {
      deps.sendJson(res, { ok: false, state: "gone", code: "not_found" }, 404);
      return true;
    }
    if (v.state === "ok") deps.flows.claim(v.id, "link");
    const message = finishedMessage(v, deps.cli);
    deps.sendJson(res, {
      ok: v.state === "pending" || v.state === "ok",
      ...flowJson(v),
      ...(message ? { error: message } : {}),
    });
    return true;
  }
  if (pathname === "/api/web/owner/unlink" && method === "POST") {
    const was = clearWebOwner(deps.stateDir());
    if (was) deps.log(`  owner unlinked (was @${was.login})`);
    deps.sendJson(res, { ok: true, was: was ? was.login : null });
    return true;
  }

  // ── Pair a device ────────────────────────────────────────────────────
  if (pathname === "/api/web/pair" && method === "GET") {
    deps.sendJson(res, { hosts: deps.edgeRoutes().map((r) => r.host) });
    return true;
  }
  if (pathname === "/api/web/pair" && method === "POST") {
    let body: { host?: unknown } = {};
    try {
      body = (JSON.parse((await deps.readBody(req)) || "{}") ??
        {}) as typeof body;
    } catch {
      deps.sendJson(
        res,
        { ok: false, error: "the body must be JSON: { host }" },
        400,
      );
      return true;
    }
    const want = String(body.host ?? "")
      .trim()
      .toLowerCase();
    const routes = deps.edgeRoutes();
    const hit = routes.find((r) => r.host === want);
    if (!hit) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "unknown_host",
          error: routes.length
            ? `${want || "(none)"} isn't an edge hostname that routes here (${routes.map((r) => r.host).join(", ")}).`
            : "No edge hostname routes to this server: add one to edge.routes or edge.aliases, then `edge up`.",
        },
        400,
      );
      return true;
    }
    const link = deps.mintLink(hit.url);
    if (!link) {
      deps.sendJson(res, { ok: false, error: "web.secret is missing" }, 500);
      return true;
    }
    deps.sendJson(res, {
      ok: true,
      host: hit.host,
      url: link.url,
      expiresAt: new Date(link.expiresAt).toISOString(),
    });
    return true;
  }
  return false;
}
