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
import { randomBytes } from "crypto";
import { GITHUB_DEVICE_PAGE } from "../../shared/github-app.js";
import type {
  GithubDeviceClient,
  GithubIdentity,
} from "../../shared/github-device.js";

export type FlowPurpose = "signin" | "link";
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
  /** error: what went wrong (no secret in it). */
  message?: string;
}

interface Flow extends FlowView {
  deviceCode: string;
  intervalMs: number;
  errors: number;
  /** ok: who approved it (the id, for the caller). */
  identity?: GithubIdentity;
  /** When a finished flow is forgotten. */
  forgetAt?: number;
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
const MAX_ERRORS = 5;

export class DeviceFlows {
  private readonly flows = new Map<string, Flow>();
  private readonly client: GithubDeviceClient;
  private readonly clientId: () => string;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly max: number;
  private readonly minIntervalMs: number;
  private readonly onExpiringToken?: () => void;
  private readonly decide: (
    purpose: FlowPurpose,
    identity: GithubIdentity,
  ) => "ok" | "refused";

  constructor(opts: {
    client: GithubDeviceClient;
    clientId: () => string;
    decide: (
      purpose: FlowPurpose,
      identity: GithubIdentity,
    ) => "ok" | "refused";
    now?: () => number;
    schedule?: Schedule;
    max?: number;
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
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
  }

  /** Pending flows now. */
  pending(): number {
    this.sweep();
    return [...this.flows.values()].filter((f) => f.state === "pending").length;
  }

  /**
   * Start a flow with GitHub. `busy` past the cap; `no_client_id` when none
   * is configured; a GitHub failure throws (its message names no secret).
   */
  async start(
    purpose: FlowPurpose,
  ): Promise<FlowView | { error: "busy" | "no_client_id" }> {
    const clientId = this.clientId();
    if (!clientId) return { error: "no_client_id" };
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
        const outcome = this.decide(f.purpose, identity);
        return this.finish(f, outcome, {
          login: identity.login,
          ...(outcome === "ok" ? { identity } : {}),
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
  };
}
