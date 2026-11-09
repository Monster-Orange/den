/**
 * SEC-2a: GitHub's device flow, for a GitHub App with only its public client
 * id (no secret), and `GET /user` for who approved it.
 *
 *  1. POST /login/device/code (client_id): a device code (kept here), a
 *     user code (shown to the person), how long both last, and the poll
 *     interval. No scope is asked for: identity needs none, and
 *     `offline_access` would force an expiring token.
 *  2. POST /login/oauth/access_token (client_id, device_code, grant_type
 *     device_code) every `interval` seconds until it answers a token, or
 *     `authorization_pending` (keep going), `slow_down` (wait longer),
 *     `expired_token` or `access_denied` (stop).
 *  3. GET /user with the token: its numeric `id` and `login`, nothing else.
 *     The caller drops the token right after.
 *
 * A token answer with `expires_in` or a `refresh_token` means the app has
 * "Expire user authorization tokens" on: the result says so (`expiring`),
 * for the caller's one warning; the sign-in still completes.
 *
 * Every call is one request on a fresh connection (no keep-alive), with a
 * timeout. Nothing here logs; a token, device code or user code is never in
 * an error message.
 */
import * as http from "http";
import * as https from "https";
import { githubEndpoints, type GithubEndpoints } from "./github-app.js";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** Seconds the codes last. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type PollResult =
  | {
      kind: "token";
      token: string;
      /**
       * The answer carried `expires_in` or a `refresh_token`: the app has
       * "Expire user authorization tokens" on, a misconfiguration (Den
       * never refreshes; it uses the token once). Never the token itself.
       */
      expiring: boolean;
    }
  | { kind: "pending" }
  | { kind: "slow_down"; interval?: number }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

export interface GithubIdentity {
  id: number;
  login: string;
}

/**
 * Whether a login is a member of an org (D17), as far as its own token can
 * tell: `member`, `not_member`, or `unreadable` (the membership is private
 * and this token may not read it: the app lacks the org's Members
 * permission, or isn't installed there).
 */
export type OrgMembership = "member" | "not_member" | "unreadable";

/** The calls, swappable in a unit test. */
export interface GithubDeviceClient {
  start(clientId: string): Promise<DeviceCode>;
  poll(clientId: string, deviceCode: string): Promise<PollResult>;
  user(token: string): Promise<GithubIdentity>;
  /**
   * D17: is `login` (the token's own account) a member of `org`? First its
   * own membership (`GET /user/memberships/orgs/<org>`, which a GitHub App
   * reads with the org's Members permission), then the public list (`GET
   * /orgs/<org>/members/<login>`: 204 for a public member). A network
   * failure throws.
   */
  orgMember(token: string, org: string, login: string): Promise<OrgMembership>;
}

const TIMEOUT_MS = 15_000;
const UA = "den-device-flow";

function request(
  url: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method,
        agent: false,
        timeout: TIMEOUT_MS,
        headers: {
          "user-agent": UA,
          connection: "close",
          ...opts.headers,
          ...(opts.body !== undefined
            ? { "content-length": String(Buffer.byteLength(opts.body)) }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf-8");
        res.on("data", (d: string) => (out += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: out }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("GitHub did not answer")));
    req.on("error", (e) =>
      reject(new Error(`GitHub unreachable: ${e.message}`)),
    );
    req.end(opts.body);
  });
}

function parse(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM_HEADERS = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
};

/** The real GitHub (or a test's fake one, githubEndpoints). */
export function githubDeviceClient(
  ep: GithubEndpoints = githubEndpoints(),
): GithubDeviceClient {
  return {
    async start(clientId) {
      const r = await request(ep.deviceCode, {
        method: "POST",
        headers: FORM_HEADERS,
        body: form({ client_id: clientId }),
      });
      const j = parse(r.body);
      if (
        r.status !== 200 ||
        typeof j.device_code !== "string" ||
        typeof j.user_code !== "string"
      ) {
        const why =
          typeof j.error === "string"
            ? j.error === "device_flow_disabled"
              ? "the GitHub App's device flow is off (tick “Enable Device Flow”)"
              : j.error === "unauthorized_client" ||
                  j.error === "incorrect_client_credentials"
                ? "GitHub doesn't know this client id (web.github_client_id)"
                : `GitHub answered ${j.error}`
            : `GitHub answered ${r.status}`;
        throw new Error(why);
      }
      return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        expiresIn: Number(j.expires_in) > 0 ? Number(j.expires_in) : 900,
        interval: Number(j.interval) >= 0 ? Number(j.interval) : 5,
      };
    },
    async poll(clientId, deviceCode) {
      let r: { status: number; body: string };
      try {
        r = await request(ep.accessToken, {
          method: "POST",
          headers: FORM_HEADERS,
          body: form({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
      const j = parse(r.body);
      if (typeof j.access_token === "string" && j.access_token)
        return {
          kind: "token",
          token: j.access_token,
          expiring: j.expires_in !== undefined || j.refresh_token !== undefined,
        };
      switch (j.error) {
        case "authorization_pending":
          return { kind: "pending" };
        case "slow_down":
          return {
            kind: "slow_down",
            ...(Number(j.interval) > 0 ? { interval: Number(j.interval) } : {}),
          };
        case "expired_token":
          return { kind: "expired" };
        case "access_denied":
          return { kind: "denied" };
        default:
          return {
            kind: "error",
            message:
              typeof j.error === "string"
                ? `GitHub answered ${j.error}`
                : `GitHub answered ${r.status}`,
          };
      }
    },
    async user(token) {
      const r = await request(ep.user, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      const j = parse(r.body);
      if (
        r.status !== 200 ||
        typeof j.id !== "number" ||
        !Number.isSafeInteger(j.id) ||
        typeof j.login !== "string"
      )
        throw new Error(`GitHub's /user answered ${r.status}`);
      return { id: j.id, login: j.login };
    },
    async orgMember(token, org, login) {
      const headers = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      };
      const own = await request(
        `${ep.api}/user/memberships/orgs/${encodeURIComponent(org)}`,
        { method: "GET", headers },
      );
      if (own.status === 200)
        return parse(own.body).state === "active" ? "member" : "not_member";
      const pub = await request(
        `${ep.api}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
        { method: "GET", headers },
      );
      if (pub.status === 204) return "member";
      // A 404 for its own membership means none; a 403 means this token
      // may not read it, so a private membership can't be told apart.
      return own.status === 404 ? "not_member" : "unreadable";
    },
  };
}

/** `github:<numeric id>`: how Den names a GitHub account. */
export function githubPrincipal(id: number): `github:${number}` {
  return `github:${id}`;
}

export type DeviceFlowOutcome =
  | { kind: "ok"; identity: GithubIdentity; expiringToken?: boolean }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/**
 * The whole flow in one call (the CLI's `web owner link`): start, show the
 * code (`onCode`), poll at GitHub's interval (`sleep`, injected in a test),
 * read the identity, drop the token. `minIntervalMs` is the floor between
 * polls (GitHub's own interval is never shorter than it says).
 */
export async function runDeviceFlow(opts: {
  clientId: string;
  client?: GithubDeviceClient;
  onCode: (code: DeviceCode) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
}): Promise<DeviceFlowOutcome> {
  const client = opts.client ?? githubDeviceClient();
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const code = await client.start(opts.clientId);
  opts.onCode(code);
  const deadline = now() + code.expiresIn * 1000;
  const floor = opts.minIntervalMs ?? 1000;
  let interval = Math.max(code.interval * 1000, floor);
  let errors = 0;
  for (;;) {
    await sleep(interval);
    if (now() >= deadline) return { kind: "expired" };
    const r = await client.poll(opts.clientId, code.deviceCode);
    if (r.kind === "token") {
      // The token lives only for this one call.
      const identity = await client.user(r.token);
      return {
        kind: "ok",
        identity,
        ...(r.expiring ? { expiringToken: true } : {}),
      };
    }
    if (r.kind === "pending") continue;
    if (r.kind === "slow_down") {
      interval = Math.max(
        r.interval !== undefined ? r.interval * 1000 : interval + 5000,
        floor,
      );
      continue;
    }
    if (r.kind === "error") {
      if (++errors >= 5) return { kind: "error", message: r.message };
      continue;
    }
    return r;
  }
}
