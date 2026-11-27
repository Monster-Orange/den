/**
 * Issue 459: the server's app event feeds (shared/agents/app-feeds.ts).
 *
 * Reads every project's `agents.event_feeds` each tick and keeps one
 * reader (shared/app-feed-reader.ts) per feed, up to embed.feed_max_streams
 * for the install. Events go into the feed's store: one small file each,
 * at most embed.feed_keep_events (the oldest go, and the bell says when an
 * unread one did). The agent is typed only a pointer (feedPointerText),
 * through the delivery loop that types Hub's comments (relayMessage):
 * typed when it is idle, never mid-turn, one pointer at a time per feed.
 * It reads the events with the app_feed_read tool (readFor), which serves
 * only feeds of the caller's own project that name the caller.
 *
 * The bearer is read from the install's secrets store at each connect and
 * goes only into the request's Authorization header: never a log line, a
 * status, an /api answer, a file or the agent's text (an error that might
 * hold it is scrubbed first). Redirects are never followed.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
  feedPointerDelivery,
  feedPointerText,
  parseAppFeeds,
  type AppFeedConfig,
  type FeedPointer,
} from "../../shared/agents/app-feeds.js";
import {
  AppFeedReader,
  type FeedCursor,
  type FeedError,
  type FeedNotice,
  type FeedState,
  type FeedStore,
  type StoredEvent,
} from "../../shared/app-feed-reader.js";
import type { Delivery } from "../../shared/hub/hub-delivery.js";
import {
  checkedAddress,
  type FeedLookup,
} from "../../shared/agents/feed-address.js";
import { pinnedFetch, type PinnedFetch } from "./feed-pinned-request.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { settingsLink } from "../../shared/settings-links.js";

export interface AppFeedLimits {
  maxStreams: number;
  eventMaxKb: number;
  perMinute: number;
  /** Events one feed keeps. */
  keepEvents: number;
  /** What one app_feed_read call returns, in KB. */
  readMaxKb: number;
  listTimeoutSeconds: number;
  listMaxMb: number;
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
  /** Whether the delivery loop still waits to type (or is typing) this id. */
  holds(id: string): boolean;
  limits(): AppFeedLimits;
  bell(n: Parameters<NotificationStore["add"]>[0]): void;
  stateDir: string;
  fetch?: typeof fetch;
  /**
   * Issues 1480, 1491: resolves a public_only feed's name at each connect
   * (default: the system's resolver). Every answer must be public, and the
   * request is pinned to the first.
   */
  lookup?: FeedLookup;
  /** Issue 1491: a public_only feed's request, pinned to its checked address. */
  pinned?: PinnedFetch;
  log?: (line: string) => void;
  retryMs?: { first: number; max: number };
  now?: () => number;
}

/** What Settings shows for a feed: never its bearer or its ref. */
export interface AppFeedView {
  name: string;
  agent: string;
  url: string;
  state: FeedState | "no_agent";
  since: number;
  last_event_at: number | null;
  unread: number;
  problem: string | null;
}

/** The events one app_feed_read call returns. */
export interface FeedRead {
  feed: string;
  events: (Omit<StoredEvent, "data"> & {
    data: string | null;
    note?: string;
  })[];
  /** More unread events after these: call again. */
  more: boolean;
  unread: number;
}

const LEGACY = "legacy";
const EPOCH = /^(legacy|[0-9a-f]{8,32})$/;
const FILE = /^(\d{1,15})-([0-9a-f]{16})-(\d{1,12}|x)\.json$/;
const kh = (key: string) =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);

/**
 * A feed's events on disk: one file each, named by its sequence number,
 * its key's hash and its size, so opening the store reads no event. The
 * read mark, the last pointer's sequence and the store's epoch go in meta.
 */
export class FileFeedStore implements FeedStore {
  private readonly seqs: number[] = [];
  private readonly files = new Map<number, string>();
  private readonly keys = new Map<string, number>();
  private readonly sizes = new Map<number, number | null>();
  private meta = { read: 0, pointed: 0, epoch: "" };

  constructor(
    private readonly dir: string,
    private readonly cap: () => number,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) {
      const m = FILE.exec(f);
      if (!m) continue;
      const seq = Number(m[1]);
      this.seqs.push(seq);
      this.files.set(seq, f);
      this.keys.set(m[2], seq);
      this.sizes.set(seq, m[3] === "x" ? null : Number(m[3]));
    }
    this.seqs.sort((a, b) => a - b);
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(dir, "meta.json"), "utf8"),
      ) as { read?: unknown; pointed?: unknown; epoch?: unknown };
      if (typeof v.read === "number") this.meta.read = v.read;
      if (typeof v.pointed === "number") this.meta.pointed = v.pointed;
      if (typeof v.epoch === "string" && EPOCH.test(v.epoch))
        this.meta.epoch = v.epoch;
    } catch {
      this.meta.epoch = "";
    }
    if (this.meta.epoch) return;
    const old =
      this.seqs.length > 0 || fs.existsSync(path.join(dir, "meta.json"));
    this.meta.epoch = old ? LEGACY : randomBytes(8).toString("hex");
    this.saveMeta();
  }

  epoch(): string {
    return this.meta.epoch === LEGACY ? "" : this.meta.epoch;
  }

  private saveMeta(): void {
    writeFileAtomic(
      path.join(this.dir, "meta.json"),
      JSON.stringify(this.meta),
      {
        mode: 0o600,
      },
    );
  }

  has(key: string): boolean {
    return this.keys.has(kh(key));
  }

  lastSeq(): number {
    return this.seqs.length ? this.seqs[this.seqs.length - 1] : this.meta.read;
  }

  add(key: string, ev: Omit<StoredEvent, "seq">): { dropped: number } {
    const seq = Math.max(this.lastSeq(), this.meta.read) + 1;
    const h = kh(key);
    const f = `${seq}-${h}-${ev.bytes === null ? "x" : ev.bytes}.json`;
    writeFileAtomic(path.join(this.dir, f), JSON.stringify({ seq, ...ev }), {
      exclusive: true,
      mode: 0o600,
    });
    this.seqs.push(seq);
    this.files.set(seq, f);
    this.keys.set(h, seq);
    this.sizes.set(seq, ev.bytes);
    let dropped = 0;
    const cap = Math.max(1, this.cap());
    while (this.seqs.length > cap) {
      const old = this.seqs.shift()!;
      const name = this.files.get(old);
      this.files.delete(old);
      this.sizes.delete(old);
      if (name) {
        const m = FILE.exec(name);
        if (m && this.keys.get(m[2]) === old) this.keys.delete(m[2]);
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {
          /* gone already */
        }
      }
      if (old > this.meta.read) dropped++;
    }
    return { dropped };
  }

  private event(seq: number): StoredEvent | null {
    const f = this.files.get(seq);
    if (!f) return null;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir, f), "utf8"),
      ) as StoredEvent;
    } catch {
      return null;
    }
  }

  private unreadSeqs(): number[] {
    return this.seqs.filter((s) => s > this.meta.read);
  }

  /** The unread events in brief (for the pointer), or null when none. */
  unread(): FeedPointer | null {
    const u = this.unreadSeqs();
    if (!u.length) return null;
    const first = this.event(u[0]);
    const last = this.event(u[u.length - 1]);
    return {
      count: u.length,
      firstId: first?.id ?? "",
      lastId: last?.id ?? "",
      bytes: u.reduce((n, s) => n + (this.sizes.get(s) ?? 0), 0),
    };
  }

  unreadCount(): number {
    return this.unreadSeqs().length;
  }

  /** Whether a pointer already names every event up to the last. */
  pointedAll(): boolean {
    return this.meta.pointed >= this.lastSeq();
  }

  setPointed(seq: number): void {
    this.meta.pointed = Math.max(this.meta.pointed, seq);
    this.saveMeta();
  }

  /**
   * Events after `after` (the read mark when null), up to `maxBytes` of
   * data in all and `limit` events. One alone past `maxBytes` comes
   * without its data. Without `after`, the read mark moves past them.
   */
  read(
    after: number | null,
    maxBytes: number,
    limit: number,
  ): { events: FeedRead["events"]; more: boolean } {
    const from = after ?? this.meta.read;
    const seqs = this.seqs.filter((s) => s > from);
    const events: FeedRead["events"] = [];
    let total = 0;
    for (const s of seqs) {
      if (events.length >= limit) break;
      const ev = this.event(s);
      if (!ev) continue;
      const size = ev.data === null ? 0 : Buffer.byteLength(ev.data, "utf8");
      if (events.length && total + size > maxBytes) break;
      if (size > maxBytes) {
        events.push({
          ...ev,
          data: null,
          note: "larger than one read returns (Settings › Embedding); its data isn't served",
        });
      } else {
        total += size;
        events.push(
          ev.data === null
            ? {
                ...ev,
                note: "over the event size limit when it came; its data wasn't kept",
              }
            : ev,
        );
      }
    }
    const lastSeq = events.length ? events[events.length - 1].seq : from;
    if (after === null && lastSeq > this.meta.read) {
      this.meta.read = lastSeq;
      this.saveMeta();
    }
    return { events, more: seqs.some((s) => s > lastSeq) };
  }
}

/** Every occurrence of `secret` out of `s` (an error may echo a header). */
function scrub(s: string, secret: string | null): string {
  return secret ? s.split(secret).join("[redacted]") : s;
}

function failure(kind: FeedError["kind"], message: string): Error {
  return Object.assign(new Error(message), { kind });
}

interface Running {
  sig: string;
  feed: AppFeedConfig;
  project: string;
  reader: AppFeedReader | null;
  ctl: AbortController | null;
  /** The last pointer relayed (the next waits until it's typed). */
  pointer?: string;
  /** When the feed isn't read: why. */
  idle?: { state: "over_limit" | "no_agent"; problem: string; since: number };
}

export class AppFeeds {
  private readonly feeds = new Map<string, Running>();
  private readonly stores = new Map<string, FileFeedStore>();
  private readonly f: typeof fetch;
  private readonly overSaid = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: AppFeedServiceDeps) {
    this.f = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
  }

  private dirOf(project: string, name: string): string {
    const h = createHash("sha256")
      .update(`${project}\0${name}`)
      .digest("hex")
      .slice(0, 24);
    return path.join(this.d.stateDir, "app-feeds", h);
  }

  private storeOf(project: string, name: string): FileFeedStore {
    const k = `${project}\0${name}`;
    let s = this.stores.get(k);
    if (!s) {
      s = new FileFeedStore(
        path.join(this.dirOf(project, name), "events"),
        () => this.d.limits().keepEvents,
      );
      this.stores.set(k, s);
    }
    return s;
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
  ): Promise<{ res: Response; bearer: string | null }> {
    // Issue 1480: a feed checked public when it was added is resolved
    // again before each connect: one whose name now gives a private
    // address is never opened (nor sent its bearer). Issue 1491: the
    // request then goes to exactly that checked address, so no second
    // lookup (a DNS rebind) can send it somewhere else.
    let pin: Awaited<ReturnType<typeof checkedAddress>> = null;
    if (feed.publicOnly) {
      try {
        pin = await checkedAddress(url, this.d.lookup);
      } catch {
        pin = null;
      }
      if (!pin)
        throw failure(
          undefined,
          "its address now names this machine or a private network, so Den won't open it: a person adds it again to allow that",
        );
    }
    const bearer = await this.auth(feed);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      // Never followed: a redirect would carry the bearer somewhere else.
      res = pin
        ? await (this.d.pinned ?? pinnedFetch)(url, {
            headers,
            address: pin.address,
            family: pin.family,
            ...(signal ? { signal } : {}),
          })
        : await this.f(url, { headers, redirect: "error", signal });
    } catch (e) {
      const c = (e as { cause?: { code?: unknown } })?.cause?.code;
      const timedOut = (e as { name?: string })?.name === "TimeoutError";
      throw failure(
        undefined,
        scrub(
          timedOut
            ? "the app didn't answer in time"
            : `couldn't reach the app${typeof c === "string" ? ` (${c})` : ""}`,
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
    return { res, bearer };
  }

  /** The list form's body, read up to `max` bytes (else refused). */
  private static async bodyUpTo(res: Response, max: number): Promise<string> {
    if (!res.body) return "";
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += chunk.byteLength;
      if (n > max) {
        await res.body.cancel().catch(() => undefined);
        throw failure(
          undefined,
          "the list form's answer is over its size limit",
        );
      }
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString("utf8");
  }

  private reader(project: string, feed: AppFeedConfig): AppFeedReader {
    const dir = this.dirOf(project, feed.name);
    const file = path.join(dir, "cursor.json");
    const where = { project, name: feed.name, agent: feed.agent };
    const request = this.request.bind(this);
    const store = this.storeOf(project, feed.name);
    return new AppFeedReader({
      feed: where,
      store,
      stored: () => void this.point(`${project}\0${feed.name}`),
      open: (lastId, signal) =>
        (async function* () {
          const headers: Record<string, string> = {
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          };
          if (lastId) headers["Last-Event-ID"] = lastId;
          const { res } = await request(feed.url, feed, headers, signal);
          const type = res.headers.get("content-type") ?? "";
          if (!/text\/event-stream/i.test(type))
            throw failure(undefined, "the app's answer is not an event stream");
          if (!res.body) return;
          const dec = new TextDecoder();
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
            yield dec.decode(chunk, { stream: true });
        })(),
      list: async (after) => {
        const l = this.d.limits();
        const u = new URL(feed.listUrl ?? feed.url);
        if (after) u.searchParams.set("after", after);
        const { res, bearer } = await this.request(
          u.href,
          feed,
          { Accept: "application/json" },
          AbortSignal.timeout(l.listTimeoutSeconds * 1000),
        );
        let text: string;
        try {
          text = await AppFeeds.bodyUpTo(res, l.listMaxMb * 1024 * 1024);
        } catch (e) {
          const name = (e as { name?: string })?.name;
          throw failure(
            undefined,
            scrub(
              name === "TimeoutError" || name === "AbortError"
                ? "the list form didn't answer in time"
                : String((e as Error)?.message ?? e),
              bearer,
            ),
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw failure(undefined, "the list form's answer is not JSON");
        }
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
      ...(this.d.now ? { now: this.d.now } : {}),
    });
  }

  private pointing = new Set<string>();

  /**
   * Type the agent one pointer for what is unread: only when the last one
   * was typed, only when there is something new, and only when the
   * feed's agent is in the feed's project now.
   */
  private async point(key: string): Promise<void> {
    const r = this.feeds.get(key);
    if (!r?.reader || this.pointing.has(key)) return;
    this.pointing.add(key);
    try {
      const store = this.storeOf(r.project, r.feed.name);
      if (store.pointedAll()) return;
      if (r.pointer && this.d.holds(r.pointer)) return;
      const u = store.unread();
      if (!u) return;
      if (this.d.agentProject(r.feed.agent) !== r.project) {
        this.d.log?.(
          `app feed ${r.project}/${r.feed.name}: ${r.feed.agent} is not in ${r.project} now: nothing typed`,
        );
        return;
      }
      const seq = store.lastSeq();
      const where = {
        project: r.project,
        name: r.feed.name,
        agent: r.feed.agent,
      };
      const dv = feedPointerDelivery(
        where,
        seq,
        feedPointerText(where, u),
        this.now(),
        store.epoch(),
      );
      if (this.d.seen(dv.id)) {
        store.setPointed(seq);
        return;
      }
      if (await this.d.relay(dv)) {
        r.pointer = dv.id;
        store.setPointed(seq);
      }
    } finally {
      this.pointing.delete(key);
    }
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
        link: settingsLink("workspace", "workspace.event_feeds"),
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
              since: this.now(),
            }
          : reading >= maxStreams
            ? {
                state: "over_limit",
                problem: `over the limit of ${maxStreams} app feed streams for this install (Settings › Embedding)`,
                since: this.now(),
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

  /** The service's tick: config again, then a pointer where one is due. */
  async tick(): Promise<void> {
    this.sync();
    for (const k of this.feeds.keys()) await this.point(k);
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
      const same = r?.sig === JSON.stringify(feed);
      const s = same ? (r?.reader?.status() ?? null) : null;
      const idle = same ? r?.idle : undefined;
      let unread = 0;
      try {
        unread = this.storeOf(ws, feed.name).unreadCount();
      } catch {
        unread = 0;
      }
      return {
        name: feed.name,
        agent: feed.agent,
        url: feed.url,
        state: idle?.state ?? s?.state ?? "connecting",
        since: idle?.since ?? s?.since ?? this.now(),
        last_event_at: s?.lastEventAt ?? null,
        unread,
        problem: idle?.problem ?? s?.problem ?? null,
      };
    });
    return { feeds, problems: parsed.problems };
  }

  /**
   * What app_feed_read serves `agent`: only feeds of its own project now
   * that name it. No `feed`: those feeds and their unread counts. With
   * `feed`: its events after `after` (unread when null, which marks them
   * read), up to embed.feed_read_max_kb of data and `limit` events.
   */
  readFor(
    agent: string,
    feed: string | null,
    after: number | null,
    limit: number,
  ):
    | { ok: true; feeds: { name: string; unread: number }[] }
    | ({ ok: true } & FeedRead)
    | { ok: false; code: "no_feed"; error: string } {
    const project = this.d.agentProject(agent);
    const mine = project
      ? parseAppFeeds(this.d.feedsOf(project)).feeds.filter(
          (f) => f.agent === agent,
        )
      : [];
    if (feed === null)
      return {
        ok: true,
        feeds: mine.map((f) => ({
          name: f.name,
          unread: this.storeOf(project!, f.name).unreadCount(),
        })),
      };
    const f = mine.find((x) => x.name === feed);
    if (!f || !project)
      return {
        ok: false,
        code: "no_feed",
        error: `You have no app feed "${feed.slice(0, 40)}" in your project.`,
      };
    const store = this.storeOf(project, f.name);
    const { events, more } = store.read(
      after,
      this.d.limits().readMaxKb * 1024,
      Math.max(1, Math.min(1000, limit)),
    );
    return {
      ok: true,
      feed: f.name,
      events,
      more,
      unread: store.unreadCount(),
    };
  }

  stop(): void {
    for (const r of this.feeds.values()) r.ctl?.abort();
    this.feeds.clear();
  }
}

let current: AppFeeds | null = null;
let timer: NodeJS.Timeout | null = null;

/** How often the server reads the config again and points, ms. */
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

/** app_feed_read for `agent`; null before the server started the feeds. */
export function appFeedRead(
  agent: string,
  feed: string | null,
  after: number | null,
  limit: number,
): ReturnType<AppFeeds["readFor"]> | null {
  return current ? current.readFor(agent, feed, after, limit) : null;
}
