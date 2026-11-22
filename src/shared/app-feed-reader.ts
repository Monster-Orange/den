/**
 * Issue 459: one app event feed, read (pull, like Hub's comments).
 *
 * Keeps the app's server-sent events stream open: from the last event id
 * (Last-Event-ID, when it is a legal header value), backing off on
 * errors, opening again at once on the app's `reset` event. Before each
 * open after a cursor exists, the list form (`?after=<cursor>`) fills any
 * gap. Each event goes into the feed's store (one small file each, never
 * a whole-file rewrite), de-duplicated by its id; the cursor is saved
 * after each one, so a restart resumes where it was. `stored` then tells
 * the service, which types the agent a pointer (never the event's text).
 *
 * Limits (Settings with permissive defaults, read at each use): an event
 * over the size limit is kept as a note that it came (never its data);
 * past the rate, the reader stops reading the stream until the minute
 * moves on (the app holds the rest: nothing is dropped here). The store
 * keeps at most its cap; the oldest go, and the bell says so.
 *
 * The bearer never reaches this file: `open` and `list` carry it. Every
 * I/O is injected (tests use fakes).
 */
import { createHash } from "node:crypto";
import { SseReader } from "./hub-delivery.js";
import { feedWord } from "./agents/app-feeds.js";

export type FeedState =
  | "connecting"
  | "connected"
  | "retrying"
  | "no_secret"
  | "over_limit"
  | "stopped";

export interface FeedStatus {
  state: FeedState;
  /** When the state last changed (ms). */
  since: number;
  lastEventAt: number | null;
  /** Den's own words for the trouble, or null; never the bearer. */
  problem: string | null;
}

/** What the project's notifications hear about (each once per spell). */
export type FeedNotice =
  | "no_secret"
  | "rejected"
  | "too_big"
  | "over_rate"
  | "dropped";

export interface FeedCursor {
  cursor: string | null;
  lastEventAt: number | null;
}

/** A failure `open` or `list` throws: `kind` when Den knows what it is. */
export interface FeedError {
  kind?: "no_secret" | "rejected" | "not_found";
  message?: string;
}

/** One event as the store keeps it. `data` null: over the size limit. */
export interface StoredEvent {
  seq: number;
  /** The app's id when it was a safe word, else Den's key for it. */
  id: string;
  type: string;
  at: number;
  bytes: number | null;
  data: string | null;
}

/** A feed's events on disk (the service's; tests use a fake). */
export interface FeedStore {
  has(key: string): boolean;
  /** Keep an event; `dropped`: unread events the cap pushed out. */
  add(key: string, ev: Omit<StoredEvent, "seq">): { dropped: number };
}

export interface AppFeedReaderDeps {
  feed: { project: string; name: string; agent: string };
  /** The stream's body as text chunks, from `lastId`; throws when it can't open. */
  open(lastId: string | null, signal: AbortSignal): AsyncIterable<string>;
  /** The list form after `after`, as JSON (a list, or { events: [...] }). */
  list(after: string | null): Promise<unknown>;
  store: FeedStore;
  /** Events went into the store: the service tells the agent. */
  stored?(): void;
  load(): FeedCursor | null;
  save(c: FeedCursor): void;
  /** app feed Settings, read at each use. */
  limits(): { eventMaxKb: number; perMinute: number };
  notice?(code: FeedNotice, detail: string): void;
  onStatus?(s: FeedStatus): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retryMs?: { first: number; max: number };
  log?: (line: string) => void;
}

/** A stream that lived this long and ended: the app's own end. */
const SHORT_LIFE_MS = 5_000;
/** Ids remembered for de-dup in this process (the store keeps its own). */
const RECENT_MAX = 5_000;
/** A Last-Event-ID Den sends: visible ASCII, no spaces, at most 256. */
const HEADER_ID = /^[\x21-\x7e]{1,256}$/;

const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

export class AppFeedReader {
  private readonly now: () => number;
  private cursor: string | null;
  private lastEventAt: number | null;
  private readonly recent = new Set<string>();
  /** When each of the last minute's events was taken. */
  private readonly taken: number[] = [];
  private readonly said = new Set<FeedNotice>();
  private st: FeedStatus;
  private signal: AbortSignal | null = null;

  constructor(private readonly d: AppFeedReaderDeps) {
    this.now = d.now ?? Date.now;
    let c: FeedCursor | null = null;
    try {
      c = d.load();
    } catch {
      c = null;
    }
    this.cursor = c?.cursor ?? null;
    this.lastEventAt = c?.lastEventAt ?? null;
    this.st = {
      state: "connecting",
      since: this.now(),
      lastEventAt: this.lastEventAt,
      problem: null,
    };
  }

  status(): FeedStatus {
    return { ...this.st, lastEventAt: this.lastEventAt };
  }

  private set(state: FeedState, problem: string | null = null): void {
    const changed = state !== this.st.state || problem !== this.st.problem;
    this.st = {
      state,
      since: changed ? this.now() : this.st.since,
      lastEventAt: this.lastEventAt,
      problem,
    };
    if (state === "connected") {
      this.said.delete("no_secret");
      this.said.delete("rejected");
    }
    if (changed) this.statusChanged();
  }

  private statusChanged(): void {
    try {
      this.d.onStatus?.(this.status());
    } catch {
      /* a listener's trouble never stops the feed */
    }
  }

  private tell(code: FeedNotice, detail: string, once = true): void {
    if (once && this.said.has(code)) return;
    this.said.add(code);
    this.d.log?.(
      `app feed ${this.d.feed.project}/${this.d.feed.name}: ${detail}`,
    );
    try {
      this.d.notice?.(code, detail);
    } catch {
      /* the bell is best effort: the status still says it */
    }
  }

  private remember(key: string): void {
    this.recent.add(key);
    if (this.recent.size > RECENT_MAX) {
      const first = this.recent.values().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
  }

  /** Past the rate: wait until the minute moves on (the app holds the rest). */
  private async paced(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.taken.length && now - this.taken[0] >= 60_000)
        this.taken.shift();
      const { perMinute } = this.d.limits();
      if (this.taken.length < perMinute) {
        this.said.delete("over_rate");
        return;
      }
      this.tell(
        "over_rate",
        `over ${perMinute} events a minute: Den reads the rest as the rate allows`,
      );
      const wait = Math.max(1, 60_000 - (now - this.taken[0]));
      const sig = this.signal;
      if (!sig || sig.aborted) return;
      await (this.d.sleep ?? defaultSleep)(wait, sig);
      if (sig.aborted) return;
    }
  }

  /** One event read from the stream or the list. */
  private async take(raw: {
    id?: string | null;
    type?: string;
    data: string | null;
    bytes?: number | null;
  }): Promise<void> {
    const ownId = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
    const word = ownId === null ? "" : feedWord(ownId, "", 64);
    const key =
      ownId === null
        ? `h-${hash(raw.data ?? `${this.now()}-${this.recent.size}`)}`
        : word || `h-${hash(ownId)}`;
    if (this.recent.has(key) || this.d.store.has(key)) {
      if (ownId !== null) this.advance(ownId);
      return;
    }
    await this.paced();
    this.remember(key);
    const { eventMaxKb } = this.d.limits();
    let data = raw.data;
    let bytes =
      raw.bytes !== undefined
        ? raw.bytes
        : data === null
          ? null
          : Buffer.byteLength(data, "utf8");
    if (data !== null && bytes !== null && bytes > eventMaxKb * 1024) {
      data = null;
    }
    if (data === null)
      this.tell(
        "too_big",
        `event ${word || "without an id"} was ${bytes === null ? "larger than" : `${Math.ceil(bytes / 1024)} KB, over`} the ${eventMaxKb} KB limit: kept without its data`,
        false,
      );
    if (data === null && bytes === null) bytes = null;
    const at = this.now();
    let dropped = 0;
    try {
      dropped = this.d.store.add(key, {
        id: key,
        type: feedWord(raw.type, "message", 64),
        at,
        bytes,
        data,
      }).dropped;
    } catch (e) {
      this.d.log?.(
        `app feed ${this.d.feed.project}/${this.d.feed.name}: couldn't keep an event: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
      return;
    }
    if (dropped > 0)
      this.tell(
        "dropped",
        `${dropped} unread event${dropped === 1 ? "" : "s"} went: the feed keeps at most its limit (Settings › Embedding)`,
        false,
      );
    this.taken.push(at);
    this.lastEventAt = at;
    if (ownId !== null) this.advance(ownId);
    else this.saveCursor();
  }

  private advance(id: string): void {
    this.cursor = id;
    this.saveCursor();
  }

  private saveCursor(): void {
    try {
      this.d.save({ cursor: this.cursor, lastEventAt: this.lastEventAt });
    } catch (e) {
      this.d.log?.(
        `app feed ${this.d.feed.project}/${this.d.feed.name}: couldn't save its cursor: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }

  private storedNow(): void {
    try {
      this.d.stored?.();
    } catch {
      /* the pointer is tried again on the service's tick */
    }
  }

  /** The list form after the cursor: fills a gap after a cut or a reset. */
  async fill(): Promise<void> {
    let v: unknown;
    try {
      v = await this.d.list(this.cursor);
    } catch (e) {
      const err = e as FeedError;
      if (err?.kind !== "not_found")
        this.d.log?.(
          `app feed ${this.d.feed.project}/${this.d.feed.name}: the list form: ${String(err?.message ?? e).slice(0, 200)}`,
        );
      return;
    }
    const items = Array.isArray(v)
      ? v
      : v &&
          typeof v === "object" &&
          Array.isArray((v as { events?: unknown }).events)
        ? (v as { events: unknown[] }).events
        : [];
    for (const it of items) {
      if (this.signal?.aborted) return;
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const id =
        typeof o.id === "string"
          ? o.id
          : typeof o.id === "number"
            ? String(o.id)
            : null;
      const type =
        typeof o.type === "string"
          ? o.type
          : typeof o.event === "string"
            ? o.event
            : "message";
      if (type === "reset") continue;
      const data =
        typeof o.data === "string" ? o.data : JSON.stringify(o.data ?? null);
      await this.take({ id, type, data });
    }
    this.storedNow();
  }

  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    const sleep = this.d.sleep ?? defaultSleep;
    const first = this.d.retryMs?.first ?? 1_000;
    const max = this.d.retryMs?.max ?? 60_000;
    let wait = first;
    const where = `${this.d.feed.project}/${this.d.feed.name}`;
    while (!signal.aborted) {
      if (this.cursor !== null) await this.fill();
      if (signal.aborted) break;
      const one = new AbortController();
      const up = () => one.abort();
      signal.addEventListener("abort", up, { once: true });
      const openedAt = this.now();
      let outcome: "ended" | "failed" | "reset" = "ended";
      const { eventMaxKb } = this.d.limits();
      const overflowed: number[] = [];
      const reader = new SseReader({
        maxBuffer: eventMaxKb * 1024 + 4096,
        maxEvent: eventMaxKb * 1024 + 4096,
        onOverflow: () => overflowed.push(1),
      });
      // A cursor that isn't a legal header value goes only by the list form.
      const lastId =
        this.cursor !== null && HEADER_ID.test(this.cursor)
          ? this.cursor
          : null;
      try {
        this.set(this.st.state === "connected" ? "connected" : "connecting");
        for await (const chunk of this.d.open(lastId, one.signal)) {
          if (this.st.state !== "connected") this.set("connected");
          for (const ev of reader.feed(chunk)) {
            if (ev.event === "reset") {
              outcome = "reset";
              break;
            }
            await this.take({
              id: ev.id ?? null,
              type: ev.event,
              data: ev.data,
            });
            if (signal.aborted) break;
          }
          while (overflowed.length) {
            overflowed.pop();
            await this.take({
              id: null,
              type: "message",
              data: null,
              bytes: null,
            });
          }
          this.storedNow();
          if (outcome === "reset" || signal.aborted) break;
        }
      } catch (e) {
        if (!signal.aborted) {
          outcome = "failed";
          const err = e as FeedError;
          const why = String(err?.message ?? e).slice(0, 200);
          if (err?.kind === "no_secret") {
            this.set("no_secret", why);
            this.tell("no_secret", why);
          } else {
            this.set("retrying", why);
            if (err?.kind === "rejected") this.tell("rejected", why);
            else this.d.log?.(`app feed ${where}: ${why}; trying again`);
          }
        }
      } finally {
        one.abort();
        signal.removeEventListener("abort", up);
      }
      if (signal.aborted) break;
      if (outcome === "reset") {
        this.d.log?.(`app feed ${where}: the app reset its stream: reopening`);
        wait = first;
        continue;
      }
      if (outcome === "ended") {
        if (this.now() - openedAt >= SHORT_LIFE_MS) wait = first;
        if (this.st.state === "connected")
          this.set("retrying", "the stream ended");
      }
      await sleep(wait, signal);
      wait = Math.min(max, wait * 2);
    }
    this.set("stopped");
  }
}

function defaultSleep(ms: number, sig: AbortSignal): Promise<void> {
  return new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
    sig.addEventListener("abort", () => (clearTimeout(t), r()), {
      once: true,
    });
  });
}
