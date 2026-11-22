/**
 * Issue 459: the server's app event feeds (shared/agents/app-feeds.ts).
 *
 * Reads every project's `agents.event_feeds` each tick, keeps one reader
 * (shared/app-feed-reader.ts) per feed, up to embed.feed_max_streams for
 * the install, and hands each event to the delivery loop that types Hub's
 * comments (hub-delivery-service relayMessage): typed when the agent is
 * idle, never mid-turn. The bearer is read from the install's secrets
 * store at each connect and goes only into the request's Authorization
 * header: never a log line, a status, an /api answer, a file or the
 * agent's text (an error that might hold it is scrubbed first).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
  feedDelivery,
  parseAppFeeds,
  type AppFeedConfig,
} from "../../shared/agents/app-feeds.js";
import {
  AppFeedReader,
  type FeedCursor,
  type FeedError,
  type FeedNotice,
  type FeedState,
  type FeedStatus,
} from "../../shared/app-feed-reader.js";
import type { Delivery } from "../../shared/hub-delivery.js";
import type { NotificationStore } from "../../shared/notifications.js";

export interface AppFeedLimits {
  maxStreams: number;
  eventMaxKb: number;
  perMinute: number;
}

export interface AppFeedServiceDeps {
  /** Every project's name. */
  projects(): string[];
  /** Project `ws`'s `agents.event_feeds` as written. */
  feedsOf(ws: string): unknown;
  /** The project an agent is in here, or null when there's no such agent. */
  agentProject(agent: string): string | null;
  /** The value of secrets.refs entry `ref`, or null when unset or unreadable. */
  secret(ref: string): Promise<string | null>;
  /** Hold a delivery for its agent; false when the loop isn't ready. */
  relay(dv: Delivery): Promise<boolean>;
  /** Whether the delivery loop has seen this id. */
  seen(id: string): boolean;
  limits(): AppFeedLimits;
  bell(n: Parameters<NotificationStore["add"]>[0]): void;
  stateDir: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  retryMs?: { first: number; max: number };
}

/** What Settings shows for a feed: never its bearer or its ref. */
export interface AppFeedView {
  name: string;
  agent: string;
  url: string;
  state: FeedState | "no_agent";
  since: number;
  last_event_at: number | null;
  waiting: number;
  problem: string | null;
}

interface Running {
  sig: string;
  feed: AppFeedConfig;
  project: string;
  reader: AppFeedReader | null;
  ctl: AbortController | null;
  /** When the feed isn't read: why. */
  idle?: { state: "over_limit" | "no_agent"; problem: string; since: number };
}

const MAX_LIST_BYTES = 8 * 1024 * 1024;

/** Every occurrence of `secret` out of `s` (an error may echo a header). */
function scrub(s: string, secret: string | null): string {
  return secret ? s.split(secret).join("[redacted]") : s;
}

function failure(kind: FeedError["kind"], message: string): Error {
  return Object.assign(new Error(message), { kind });
}

export class AppFeeds {
  private readonly feeds = new Map<string, Running>();
  private readonly f: typeof fetch;
  private readonly overSaid = new Set<string>();

  constructor(private readonly d: AppFeedServiceDeps) {
    this.f = d.fetch ?? fetch;
  }

  private cursorFile(project: string, name: string): string {
    const h = createHash("sha256")
      .update(`${project}\0${name}`)
      .digest("hex")
      .slice(0, 24);
    return path.join(this.d.stateDir, "app-feeds", `${h}.json`);
  }

  /** The Authorization header for `feed`, read now; throws when it can't be. */
  private async auth(feed: AppFeedConfig): Promise<string | null> {
    if (!feed.bearer) return null;
    let v: string | null = null;
    try {
      v = await this.d.secret(feed.bearer);
    } catch {
      v = null;
    }
    if (!v)
      throw failure(
        "no_secret",
        `secrets.refs.${feed.bearer} is not set, or can't be read from this install's secrets store`,
      );
    return v;
  }

  private async request(
    url: string,
    feed: AppFeedConfig,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const bearer = await this.auth(feed);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      // Never followed: a redirect would carry the bearer somewhere else.
      res = await this.f(url, { headers, redirect: "error", signal });
    } catch (e) {
      const c = (e as { cause?: { code?: unknown } })?.cause?.code;
      throw failure(
        undefined,
        scrub(
          `couldn't reach the app${typeof c === "string" ? ` (${c})` : ""}`,
          bearer,
        ),
      );
    }
    if (res.status === 401 || res.status === 403)
      throw failure(
        "rejected",
        `the app refused the request (HTTP ${res.status}): check secrets.refs.${feed.bearer ?? "(none set)"}`,
      );
    if (res.status === 404) throw failure("not_found", "HTTP 404");
    if (!res.ok)
      throw failure(undefined, `the app answered HTTP ${res.status}`);
    return res;
  }

  private reader(project: string, feed: AppFeedConfig): AppFeedReader {
    const file = this.cursorFile(project, feed.name);
    const where = { project, name: feed.name, agent: feed.agent };
    const request = this.request.bind(this);
    return new AppFeedReader({
      feed: where,
      open: (lastId, signal) =>
        (async function* () {
          const headers: Record<string, string> = {
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          };
          if (lastId) headers["Last-Event-ID"] = lastId;
          const res = await request(feed.url, feed, headers, signal);
          const type = res.headers.get("content-type") ?? "";
          if (!/text\/event-stream/i.test(type))
            throw failure(undefined, "the app's answer is not an event stream");
          if (!res.body) return;
          const dec = new TextDecoder();
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
            yield dec.decode(chunk, { stream: true });
        })(),
      list: async (after) => {
        const u = new URL(feed.listUrl ?? feed.url);
        if (after) u.searchParams.set("after", after);
        const res = await this.request(u.href, feed, {
          Accept: "application/json",
        });
        const text = await res.text();
        if (text.length > MAX_LIST_BYTES)
          throw failure(undefined, "the list form's answer is too large");
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw failure(undefined, "the list form's answer is not JSON");
        }
      },
      deliver: async (key, text, at) => {
        const dv = feedDelivery(where, key, text, at);
        if (this.d.seen(dv.id)) return "seen";
        const ok = await this.d.relay(dv);
        if (ok) return "held";
        return this.d.seen(dv.id) ? "seen" : "not_ready";
      },
      load: () => {
        try {
          const v = JSON.parse(fs.readFileSync(file, "utf8")) as FeedCursor;
          return {
            cursor: typeof v?.cursor === "string" ? v.cursor : null,
            lastEventAt:
              typeof v?.lastEventAt === "number" ? v.lastEventAt : null,
          };
        } catch {
          return null;
        }
      },
      save: (c) => writeFileAtomic(file, JSON.stringify(c), { mode: 0o600 }),
      limits: () => {
        const l = this.d.limits();
        return { eventMaxKb: l.eventMaxKb, perMinute: l.perMinute };
      },
      notice: (code, detail) => this.notice(project, feed, code, detail),
      log: this.d.log,
      ...(this.d.retryMs ? { retryMs: this.d.retryMs } : {}),
    });
  }

  private notice(
    project: string,
    feed: AppFeedConfig,
    code: FeedNotice | "over_streams",
    detail: string,
  ): void {
    try {
      this.d.bell({
        kind: "service",
        subject: `record:app-feed-${project}-${feed.name}-${code}`,
        scope: `workspace/${project}`,
        text: `App feed "${feed.name}" for ${feed.agent}: ${detail}`,
        msg: {
          key: `bell.m.appFeed.${code}`,
          vars: { name: feed.name, agent: feed.agent },
        },
        link: "/settings",
      });
    } catch {
      /* best effort: Settings still shows it */
    }
  }

  /** Read the config again: start new feeds, stop gone or changed ones. */
  sync(): void {
    const want: { key: string; project: string; feed: AppFeedConfig }[] = [];
    for (const ws of this.d.projects().slice().sort()) {
      let raw: unknown;
      try {
        raw = this.d.feedsOf(ws);
      } catch {
        continue;
      }
      for (const feed of parseAppFeeds(raw).feeds)
        want.push({ key: `${ws}\0${feed.name}`, project: ws, feed });
    }
    const keys = new Set(want.map((w) => w.key));
    for (const [k, r] of this.feeds)
      if (!keys.has(k)) {
        r.ctl?.abort();
        this.feeds.delete(k);
      }
    const { maxStreams } = this.d.limits();
    let reading = 0;
    for (const w of want) {
      const sig = JSON.stringify(w.feed);
      let r = this.feeds.get(w.key);
      if (r && r.sig !== sig) {
        r.ctl?.abort();
        this.feeds.delete(w.key);
        r = undefined;
      }
      const owner = this.d.agentProject(w.feed.agent);
      const idle: Running["idle"] =
        owner !== w.project
          ? {
              state: "no_agent",
              problem: `project ${w.project} has no agent ${w.feed.agent}`,
              since: Date.now(),
            }
          : reading >= maxStreams
            ? {
                state: "over_limit",
                problem: `over the limit of ${maxStreams} app feed streams for this install (Settings › Embedding)`,
                since: Date.now(),
              }
            : undefined;
      if (!idle) reading++;
      if (idle) {
        if (r?.ctl) r.ctl.abort();
        const keep = r?.idle?.state === idle.state ? r.idle : idle;
        this.feeds.set(w.key, {
          sig,
          feed: w.feed,
          project: w.project,
          reader: null,
          ctl: null,
          idle: keep,
        });
        if (idle.state === "over_limit" && !this.overSaid.has(w.key)) {
          this.overSaid.add(w.key);
          this.notice(w.project, w.feed, "over_streams", idle.problem);
          this.d.log?.(
            `app feed ${w.project}/${w.feed.name}: ${idle.problem}: not read`,
          );
        }
        continue;
      }
      this.overSaid.delete(w.key);
      if (r?.reader) continue;
      const reader = this.reader(w.project, w.feed);
      const ctl = new AbortController();
      this.feeds.set(w.key, {
        sig,
        feed: w.feed,
        project: w.project,
        reader,
        ctl,
      });
      void reader
        .run(ctl.signal)
        .catch((e) =>
          this.d.log?.(
            `app feed ${w.project}/${w.feed.name} stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
          ),
        );
    }
  }

  /** The service's tick: config again, then what waits for the rate. */
  async tick(): Promise<void> {
    this.sync();
    for (const r of this.feeds.values()) await r.reader?.drain();
  }

  /** Project `ws`'s feeds as Settings shows them. */
  view(ws: string): { feeds: AppFeedView[]; problems: string[] } {
    let raw: unknown;
    try {
      raw = this.d.feedsOf(ws);
    } catch {
      raw = undefined;
    }
    const parsed = parseAppFeeds(raw);
    const feeds = parsed.feeds.map((feed): AppFeedView => {
      const r = this.feeds.get(`${ws}\0${feed.name}`);
      const s: FeedStatus | null =
        r?.sig === JSON.stringify(feed) ? (r.reader?.status() ?? null) : null;
      const idle = r?.sig === JSON.stringify(feed) ? r.idle : undefined;
      return {
        name: feed.name,
        agent: feed.agent,
        url: feed.url,
        state: idle?.state ?? s?.state ?? "connecting",
        since: idle?.since ?? s?.since ?? Date.now(),
        last_event_at: s?.lastEventAt ?? null,
        waiting: s?.waiting ?? 0,
        problem: idle?.problem ?? s?.problem ?? null,
      };
    });
    return { feeds, problems: parsed.problems };
  }

  stop(): void {
    for (const r of this.feeds.values()) r.ctl?.abort();
    this.feeds.clear();
  }
}

let current: AppFeeds | null = null;
let timer: NodeJS.Timeout | null = null;

/** How often the server reads the config again and drains, ms. */
export const APP_FEED_TICK_MS = 5_000;

/** The server's feeds: one AppFeeds, ticked every APP_FEED_TICK_MS. */
export function startAppFeeds(d: AppFeedServiceDeps): AppFeeds {
  current?.stop();
  const feeds = (current = new AppFeeds(d));
  feeds.sync();
  if (timer) clearInterval(timer);
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    feeds
      .tick()
      .catch((e) =>
        d.log?.(
          `app feeds: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ),
      )
      .finally(() => (busy = false));
  }, APP_FEED_TICK_MS);
  timer.unref();
  return feeds;
}

/** Project `ws`'s feeds for Settings; none before the server started them. */
export function appFeedsView(ws: string): {
  feeds: AppFeedView[];
  problems: string[];
} {
  return current ? current.view(ws) : { feeds: [], problems: [] };
}
