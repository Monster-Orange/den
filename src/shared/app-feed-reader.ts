/**
 * Issue 459: one app event feed, read (pull, like Hub's comments).
 *
 * Keeps the app's server-sent events stream open: from the last event id
 * (Last-Event-ID), backing off on errors, opening again at once on the
 * app's `reset` event. Before each open after a cursor exists, the list
 * form (`?after=<cursor>`) fills any gap. Each event goes to the agent
 * through `deliver` (the delivery loop: typed when the agent is idle,
 * never mid-turn), de-duplicated by its id; the cursor is saved after
 * each one, so a restart resumes where it was.
 *
 * Limits (Settings with permissive defaults, read at each use): an event
 * over the size limit is typed as Den's note that it came (never its
 * data), and one past the rate waits, typed as the rate allows. Neither
 * is dropped, and the project's notifications say so (`notice`).
 *
 * The bearer never reaches this file: `open` and `list` carry it. Every
 * I/O is injected (tests use fakes).
 */
import { createHash } from "node:crypto";
import { SseReader } from "./hub-delivery.js";
import {
  feedEventText,
  feedTooBigText,
  feedWord,
  type FeedEvent,
} from "./agents/app-feeds.js";

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
  /** Events read and waiting for the rate, or for Den to be ready. */
  waiting: number;
}

/** What the project's notifications hear about (each once per spell). */
export type FeedNotice = "no_secret" | "rejected" | "too_big" | "over_rate";

export interface FeedCursor {
  cursor: string | null;
  lastEventAt: number | null;
}

/** A failure `open` or `list` throws: `kind` when Den knows what it is. */
export interface FeedError {
  kind?: "no_secret" | "rejected" | "not_found";
  message?: string;
}

export interface AppFeedReaderDeps {
  feed: { project: string; name: string; agent: string };
  /** The stream's body as text chunks, from `lastId`; throws when it can't open. */
  open(lastId: string | null, signal: AbortSignal): AsyncIterable<string>;
  /** The list form after `after`, as JSON (a list, or { events: [...] }). */
  list(after: string | null): Promise<unknown>;
  /** Hand one event to the agent: held, seen before, or Den not ready yet. */
  deliver(
    key: string,
    text: string,
    at: number,
  ): Promise<"held" | "seen" | "not_ready">;
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

/** One event read, waiting to go to the agent. */
interface Pending {
  key: string;
  /** The app's own id: the cursor after it's handed on (null: none). */
  cursor: string | null;
  text: string;
  at: number;
}

/** A stream that lived this long and ended: the app's own end. */
const SHORT_LIFE_MS = 5_000;
/** Ids remembered for de-dup in this process (the loop keeps its own). */
const RECENT_MAX = 5_000;

const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

export class AppFeedReader {
  private readonly now: () => number;
  private cursor: string | null;
  private readCursor: string | null;
  private lastEventAt: number | null;
  private readonly recent = new Set<string>();
  private readonly pending: Pending[] = [];
  /** When each of the last minute's events was handed on. */
  private readonly sent: number[] = [];
  private readonly said = new Set<FeedNotice>();
  private draining = false;
  private st: FeedStatus;

  constructor(private readonly d: AppFeedReaderDeps) {
    this.now = d.now ?? Date.now;
    let c: FeedCursor | null = null;
    try {
      c = d.load();
    } catch {
      c = null;
    }
    this.cursor = c?.cursor ?? null;
    this.readCursor = this.cursor;
    this.lastEventAt = c?.lastEventAt ?? null;
    this.st = {
      state: "connecting",
      since: this.now(),
      lastEventAt: this.lastEventAt,
      problem: null,
      waiting: 0,
    };
  }

  status(): FeedStatus {
    return { ...this.st, waiting: this.pending.length };
  }

  private set(state: FeedState, problem: string | null = null): void {
    const changed = state !== this.st.state || problem !== this.st.problem;
    this.st = {
      state,
      since: changed ? this.now() : this.st.since,
      lastEventAt: this.lastEventAt,
      problem,
      waiting: this.pending.length,
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

  /** One event read from the stream or the list. */
  private take(raw: { id?: string | null; type?: string; data: string }): void {
    const ownId = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
    const key =
      ownId === null
        ? `h-${hash(raw.data)}`
        : feedWord(ownId, "") || `h-${hash(ownId)}`;
    if (ownId !== null) this.readCursor = ownId;
    if (this.recent.has(key)) return;
    this.remember(key);
    const ev: FeedEvent = {
      id: ownId ?? "",
      type: raw.type ?? "message",
      data: raw.data,
    };
    const { eventMaxKb } = this.d.limits();
    const bytes = Buffer.byteLength(raw.data, "utf8");
    let text: string;
    if (bytes > eventMaxKb * 1024) {
      text = feedTooBigText(this.d.feed, { ...ev, bytes }, eventMaxKb);
      this.tell(
        "too_big",
        `event ${feedWord(ev.id, "without an id")} was ${Math.ceil(bytes / 1024)} KB, over the ${eventMaxKb} KB limit: the agent is told it came, without its data`,
        false,
      );
    } else text = feedEventText(this.d.feed, ev);
    this.pending.push({ key, cursor: ownId, text, at: this.now() });
  }

  /** A stream line past the size limit was skipped: the agent hears it came. */
  private overflowed(): void {
    const { eventMaxKb } = this.d.limits();
    const key = `big-${this.now()}-${this.recent.size}`;
    this.remember(key);
    this.pending.push({
      key,
      cursor: null,
      text: feedTooBigText(
        this.d.feed,
        { id: "", type: "message", bytes: null },
        eventMaxKb,
      ),
      at: this.now(),
    });
    this.tell(
      "too_big",
      `an event larger than the ${eventMaxKb} KB limit: the agent is told it came, without its data`,
      false,
    );
  }

  private remember(key: string): void {
    this.recent.add(key);
    if (this.recent.size > RECENT_MAX) {
      const first = this.recent.values().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
  }

  /**
   * Hand on what waits, oldest first, as the rate allows. Called after
   * each read and on the service's tick.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const now = this.now();
        while (this.sent.length && now - this.sent[0] >= 60_000)
          this.sent.shift();
        const { perMinute } = this.d.limits();
        if (this.sent.length >= perMinute) {
          this.tell(
            "over_rate",
            `over ${perMinute} events a minute: ${this.pending.length} wait and are typed as the rate allows`,
          );
          break;
        }
        const p = this.pending[0];
        let r: "held" | "seen" | "not_ready";
        try {
          r = await this.d.deliver(p.key, p.text, p.at);
        } catch {
          r = "not_ready";
        }
        if (r === "not_ready") break;
        this.pending.shift();
        if (r === "held") {
          this.sent.push(now);
          this.lastEventAt = now;
        }
        if (p.cursor !== null) this.cursor = p.cursor;
        this.saveCursor();
      }
      if (!this.pending.length) this.said.delete("over_rate");
    } finally {
      this.draining = false;
      this.st = { ...this.st, lastEventAt: this.lastEventAt };
      this.statusChanged();
    }
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

  /** The list form after the cursor: fills a gap after a cut or a reset. */
  async fill(): Promise<void> {
    let v: unknown;
    try {
      v = await this.d.list(this.readCursor);
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
        ? ((v as { events: unknown[] }).events as unknown[])
        : [];
    for (const it of items) {
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
      this.take({ id, type, data });
    }
    await this.drain();
  }

  async run(signal: AbortSignal): Promise<void> {
    const sleep =
      this.d.sleep ??
      ((ms: number, sig: AbortSignal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          t.unref?.();
          sig.addEventListener("abort", () => (clearTimeout(t), r()), {
            once: true,
          });
        }));
    const first = this.d.retryMs?.first ?? 1_000;
    const max = this.d.retryMs?.max ?? 60_000;
    let wait = first;
    const where = `${this.d.feed.project}/${this.d.feed.name}`;
    while (!signal.aborted) {
      if (this.readCursor !== null) await this.fill();
      if (signal.aborted) break;
      const one = new AbortController();
      const up = () => one.abort();
      signal.addEventListener("abort", up, { once: true });
      const openedAt = this.now();
      let outcome: "ended" | "failed" | "reset" = "ended";
      const { eventMaxKb } = this.d.limits();
      const reader = new SseReader({
        maxBuffer: eventMaxKb * 1024 + 4096,
        onOverflow: () => this.overflowed(),
      });
      try {
        this.set(this.st.state === "connected" ? "connected" : "connecting");
        for await (const chunk of this.d.open(this.readCursor, one.signal)) {
          if (this.st.state !== "connected") this.set("connected");
          for (const ev of reader.feed(chunk)) {
            if (ev.event === "reset") {
              outcome = "reset";
              break;
            }
            this.take({ id: ev.id ?? null, type: ev.event, data: ev.data });
          }
          await this.drain();
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
