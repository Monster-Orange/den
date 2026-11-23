/**
 * SEC-2a: the device flows the server runs for the browser. The page asks
 * for one (Sign in with GitHub on the signed-out page, or Link your GitHub
 * account in Settings › Access); the server starts it with GitHub, polls
 * GitHub itself at GitHub's interval, and the page polls the server for the
 * outcome by the flow's id (a random handle only the page that started it
 * holds).
 *
 *  - The device code never leaves the server; the user code goes to that
 *    page only. The token lives for one `GET /user` call and is dropped.
 *  - At most `max` flows (default 3) are pending at once: another start is
 *    refused (`busy`) until one ends. A pending flow ends at GitHub's
 *    expiry; a finished one is forgotten a minute later, or when the page
 *    claims it.
 *  - What an identity means is the caller's (`decide`): for a sign-in,
 *    whether it is the owner; for a link, storing it as the owner.
 *
 * Clock and timers are injected, so a test drives every step.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { GITHUB_DEVICE_PAGE } from "../../shared/github-app.js";
import type {
  GithubDeviceClient,
  GithubIdentity,
  OrgMembership,
} from "../../shared/github-device.js";

/** What `decide` may ask while the token is still held (D17). */
export interface DecideContext {
  /**
   * D17: the sign-in started with this machine's proof ("This is my
   * computer", attest-code.ts).
   */
  local: boolean;
  /** Whether the approving account is a member of `org`. */
  orgMember(org: string): Promise<OrgMembership>;
  /** The flow's id (FB: which held report this approval sends). */
  id: string;
  /** FB: one REST call as the approving person, with the flow's token. */
  api(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** What an identity means: ok, or refused (with why, for the page). */
export type Decision =
  | "ok"
  | "refused"
  | { refused: string }
  /** ok, with what the page is told (FB: the filed issue's link). */
  | { ok: Record<string, unknown> };

export type Decide = (
  purpose: FlowPurpose,
  identity: GithubIdentity,
  ctx: DecideContext,
) => Decision | Promise<Decision>;

export type FlowPurpose = "signin" | "link" | "report";
export type FlowState =
  | "pending"
  | "ok"
  | "refused"
  | "expired"
  | "denied"
  | "error";

/** What the page is told about a flow (never the device code). */
export interface FlowView {
  id: string;
  purpose: FlowPurpose;
  state: FlowState;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  /** ok or refused: the GitHub login that approved it. */
  login?: string;
  /** error: what went wrong; refused: why, when the decision said (no secret in it). */
  message?: string;
  /** ok: what the decision told the page (FB: the issue's link). */
  result?: Record<string, unknown>;
}

interface Flow extends FlowView {
  deviceCode: string;
  intervalMs: number;
  errors: number;
  /** ok: who approved it (the id, for the caller). */
  identity?: GithubIdentity;
  /** D17: started with this machine's proof. */
  local: boolean;
  /** When a finished flow is forgotten. */
  forgetAt?: number;
  /** Issue 362: the address that started it, when known. */
  client?: string;
  /** The browser that started it (its signed tag), when it sent one. */
  browser?: string;
  cancel?: () => void;
}

export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** How long a finished flow waits for its page to claim it. */
export const FINISHED_KEEP_MS = 60_000;
/** The most pending flows at once (SEC-2a: "rate-limit concurrent device flows"). */
export const MAX_PENDING_FLOWS = 3;
/**
 * Issue 362: new flows a minute from one address, by default (the
 * pairing requests' own number, web.pair_requests_per_minute).
 */
export const MAX_FLOWS_PER_CLIENT_MINUTE = 30;
const MAX_ERRORS = 5;

/** The cookie a GitHub sign-in start tags its browser with. */
export const BROWSER_COOKIE = "den_gh_b";

/**
 * The browser tag for a start: the one its cookie holds when Den signed
 * it, else a new one, with the Set-Cookie line that keeps it (HttpOnly,
 * SameSite=Strict, sent only to the GitHub routes).
 */
export function browserTagFor(
  cookieHeader: string | undefined,
  flows: Pick<DeviceFlows, "browserTag" | "browserOk">,
  /** The request came over https: the cookie is Secure too. */
  secure = false,
): { tag: string; setCookie?: string } {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    const tag = v.join("=");
    if (k === BROWSER_COOKIE && flows.browserOk(tag)) return { tag };
  }
  const tag = flows.browserTag();
  return {
    tag,
    setCookie: `${BROWSER_COOKIE}=${tag}; Path=/api/github; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`,
  };
}

export class DeviceFlows {
  private readonly flows = new Map<string, Flow>();
  /** Issue 362: when each address started its flows this minute. */
  private readonly started = new Map<string, number[]>();
  private readonly perClient: number | (() => number);
  private readonly client: GithubDeviceClient;
  private readonly clientId: () => string;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly max: number;
  private readonly minIntervalMs: number;
  private readonly onExpiringToken?: () => void;
  private readonly decide: Decide;
  /** Signs browser tags; new each start of the server. */
  private readonly tagKey = randomBytes(32);

  constructor(opts: {
    client: GithubDeviceClient;
    clientId: () => string;
    decide: Decide;
    now?: () => number;
    schedule?: Schedule;
    max?: number;
    /** Issue 362: new flows a minute from one address (a Setting). */
    perClient?: number | (() => number);
    /** The floor between polls (GitHub's interval is never shortened). */
    minIntervalMs?: number;
    /**
     * A token answer carried expires_in or a refresh_token: the app has
     * token expiry on (a misconfiguration). Called with no token.
     */
    onExpiringToken?: () => void;
  }) {
    this.onExpiringToken = opts.onExpiringToken;
    this.client = opts.client;
    this.clientId = opts.clientId;
    this.decide = opts.decide;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.max = opts.max ?? MAX_PENDING_FLOWS;
    this.perClient = opts.perClient ?? MAX_FLOWS_PER_CLIENT_MINUTE;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
  }

  /** A new browser tag, signed by this server. */
  browserTag(): string {
    const r = randomBytes(18).toString("base64url");
    return `${r}.${this.sign(r)}`;
  }

  /** Whether `tag` is one this server signed. */
  browserOk(tag: string | undefined): boolean {
    if (!tag || tag.length > 128) return false;
    const [r, mac, extra] = tag.split(".");
    if (!r || !mac || extra !== undefined) return false;
    const want = Buffer.from(this.sign(r));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private sign(r: string): string {
    return createHmac("sha256", this.tagKey)
      .update(r)
      .digest("base64url")
      .slice(0, 22);
  }

  /** Pending flows now. */
  pending(): number {
    this.sweep();
    return [...this.flows.values()].filter((f) => f.state === "pending").length;
  }

  /**
   * Start a flow with GitHub. `busy` past the cap, or when its address
   * started its number this minute; `no_client_id` when none is
   * configured; a GitHub failure throws (its message names no secret).
   * Issue 362: a start replaces the pending flow of the same browser at
   * the same address (a page reloaded; with no signed tag, the address's
   * untagged one). Two browsers behind one address keep theirs. An
   * address holds all slots but one at most: past that a new start is
   * busy, so one address can't fill every slot or cancel another's.
   */
  async start(
    purpose: FlowPurpose,
    meta: { local?: boolean; client?: string; browser?: string } = {},
  ): Promise<FlowView | { error: "busy" | "no_client_id" }> {
    const clientId = this.clientId();
    if (!clientId) return { error: "no_client_id" };
    const who = meta.client ? String(meta.client).slice(0, 64) : "";
    const browser = this.browserOk(meta.browser) ? meta.browser : undefined;
    if (who) {
      const now = this.now();
      // Addresses with no start this minute are forgotten.
      for (const [a, ts] of this.started)
        if (!ts.some((t) => now - t < 60_000)) this.started.delete(a);
      const made = (this.started.get(who) ?? []).filter(
        (t) => now - t < 60_000,
      );
      const cap =
        typeof this.perClient === "function"
          ? this.perClient()
          : this.perClient;
      if (made.length >= cap) {
        this.started.set(who, made);
        return { error: "busy" };
      }
      this.started.set(who, [...made, now]);
      const mine = () =>
        [...this.flows.values()].filter(
          (f) => f.client === who && f.state === "pending",
        );
      for (const f of mine())
        if (f.browser === browser) {
          f.cancel?.();
          this.flows.delete(f.id);
        }
      // Past its share another browser's start is busy: one address
      // never fills every slot, and never cancels a sign-in in progress.
      if (mine().length >= Math.max(1, this.max - 1)) return { error: "busy" };
    }
    if (this.pending() >= this.max) return { error: "busy" };
    // Held as pending while GitHub answers, so a burst can't pass the cap.
    const id = randomBytes(24).toString("base64url");
    const placeholder: Flow = {
      id,
      purpose,
      state: "pending",
      userCode: "",
      verificationUri: GITHUB_DEVICE_PAGE,
      expiresAt: this.now() + 60_000,
      deviceCode: "",
      intervalMs: this.minIntervalMs,
      errors: 0,
      local: meta.local === true,
      ...(who ? { client: who } : {}),
      ...(who && browser ? { browser } : {}),
    };
    this.flows.set(id, placeholder);
    let code;
    try {
      code = await this.client.start(clientId);
    } catch (e) {
      this.flows.delete(id);
      throw e;
    }
    const flow: Flow = {
      ...placeholder,
      userCode: code.userCode,
      deviceCode: code.deviceCode,
      expiresAt: this.now() + code.expiresIn * 1000,
      intervalMs: Math.max(code.interval * 1000, this.minIntervalMs),
    };
    this.flows.set(id, flow);
    this.arm(flow);
    return view(flow);
  }

  /** A flow's view, or null when there is none (or it was forgotten). */
  get(id: string, purpose?: FlowPurpose): FlowView | null {
    this.sweep();
    const f = this.flows.get(id);
    if (!f || (purpose && f.purpose !== purpose)) return null;
    return view(f);
  }

  /**
   * The identity of a finished, approved flow, once: the flow is forgotten,
   * so a second claim gets null (a sign-in makes one session).
   */
  claim(id: string, purpose: FlowPurpose): GithubIdentity | null {
    this.sweep();
    const f = this.flows.get(id);
    if (!f || f.purpose !== purpose || f.state !== "ok" || !f.identity)
      return null;
    this.flows.delete(id);
    return f.identity;
  }

  /** Stop every flow (the server is stopping). */
  stopAll(): void {
    for (const f of this.flows.values()) f.cancel?.();
    this.flows.clear();
  }

  private arm(f: Flow): void {
    f.cancel = this.schedule(() => void this.tick(f.id), f.intervalMs);
  }

  private finish(
    f: Flow,
    state: Exclude<FlowState, "pending">,
    extra: Partial<Flow> = {},
  ): void {
    Object.assign(f, extra, {
      state,
      deviceCode: "",
      forgetAt: this.now() + FINISHED_KEEP_MS,
    });
    f.cancel?.();
    f.cancel = undefined;
  }

  private async tick(id: string): Promise<void> {
    const f = this.flows.get(id);
    if (!f || f.state !== "pending") return;
    if (this.now() >= f.expiresAt) return this.finish(f, "expired");
    const r = await this.client.poll(this.clientId(), f.deviceCode);
    if (this.flows.get(id) !== f || f.state !== "pending") return;
    switch (r.kind) {
      case "pending":
        return this.arm(f);
      case "slow_down":
        f.intervalMs = Math.max(
          r.interval !== undefined ? r.interval * 1000 : f.intervalMs + 5000,
          this.minIntervalMs,
        );
        return this.arm(f);
      case "expired":
        return this.finish(f, "expired");
      case "denied":
        return this.finish(f, "denied");
      case "error":
        if (++f.errors >= MAX_ERRORS)
          return this.finish(f, "error", { message: r.message });
        return this.arm(f);
      case "token": {
        if (r.expiring) this.onExpiringToken?.();
        let identity: GithubIdentity;
        try {
          // The token is used for this one call and dropped with `r`.
          identity = await this.client.user(r.token);
        } catch (e) {
          return this.finish(f, "error", { message: (e as Error).message });
        }
        let decision: Decision;
        try {
          // The token is still only for this flow's own calls, then dropped.
          const token = r.token;
          decision = await this.decide(f.purpose, identity, {
            local: f.local,
            orgMember: (org) =>
              this.client.orgMember(token, org, identity.login),
            id: f.id,
            api: (method, apiPath, body) => {
              if (!this.client.api)
                return Promise.reject(new Error("no GitHub API client"));
              return this.client.api(token, method, apiPath, body);
            },
          });
        } catch (e) {
          return this.finish(f, "error", { message: (e as Error).message });
        }
        if (this.flows.get(id) !== f || f.state !== "pending") return;
        const okResult =
          typeof decision === "object" && "ok" in decision
            ? decision.ok
            : undefined;
        const outcome =
          typeof decision === "string" ? decision : okResult ? "ok" : "refused";
        return this.finish(f, outcome, {
          login: identity.login,
          ...(outcome === "ok" ? { identity } : {}),
          ...(okResult ? { result: okResult } : {}),
          ...(typeof decision === "object" && "refused" in decision
            ? { message: decision.refused }
            : {}),
        });
      }
    }
  }

  /** Expire pending flows past their time; forget old finished ones. */
  private sweep(): void {
    const now = this.now();
    for (const [id, f] of this.flows) {
      if (f.state === "pending" && f.deviceCode && now >= f.expiresAt)
        this.finish(f, "expired");
      if (f.forgetAt !== undefined && now >= f.forgetAt) this.flows.delete(id);
    }
  }
}

function view(f: Flow): FlowView {
  return {
    id: f.id,
    purpose: f.purpose,
    state: f.state,
    userCode: f.userCode,
    verificationUri: f.verificationUri,
    expiresAt: f.expiresAt,
    ...(f.login !== undefined ? { login: f.login } : {}),
    ...(f.message !== undefined ? { message: f.message } : {}),
    ...(f.result !== undefined ? { result: f.result } : {}),
  };
}
