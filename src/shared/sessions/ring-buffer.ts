/**
 * Scrollback (AG spec §3): a ring buffer per session that keeps the newest
 * bytes (default 2 MB), and its log at `<stateDir>/sessions/<id>.log`, so a
 * host that restarted can still replay a session's history.
 *
 * The log is appended to as output arrives (flushed every `flushMs`), and
 * rewritten from the ring once it passes twice the ring's capacity, so it
 * never grows without bound. A truncation can split a multi-byte character
 * or an escape sequence at the very start of a replay; a terminal shrugs
 * that off.
 */
import * as fs from "fs";

export const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;

export class ScrollbackRing {
  private buf: Buffer;
  /** Index of the oldest byte. */
  private start = 0;
  private length = 0;
  private droppedBytes = 0;

  constructor(readonly capacity: number = DEFAULT_SCROLLBACK_BYTES) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error(`scrollback capacity must be a positive whole number`);
    this.buf = Buffer.alloc(capacity);
  }

  get size(): number {
    return this.length;
  }

  /** Bytes pushed out of the ring so far. */
  get dropped(): number {
    return this.droppedBytes;
  }

  push(chunk: Uint8Array): void {
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (data.length >= this.capacity) {
      this.droppedBytes += this.length + data.length - this.capacity;
      data = data.subarray(data.length - this.capacity);
      data.copy(this.buf, 0);
      this.start = 0;
      this.length = this.capacity;
      return;
    }
    const overflow = this.length + data.length - this.capacity;
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity;
      this.length -= overflow;
      this.droppedBytes += overflow;
    }
    const end = (this.start + this.length) % this.capacity;
    const first = Math.min(data.length, this.capacity - end);
    data.copy(this.buf, end, 0, first);
    if (first < data.length) data.copy(this.buf, 0, first);
    this.length += data.length;
  }

  /** The newest `maxBytes` (all of it by default), oldest first. */
  snapshot(maxBytes: number = this.capacity): Buffer {
    const n = Math.max(0, Math.min(maxBytes, this.length));
    const from = (this.start + this.length - n) % this.capacity;
    if (from + n <= this.capacity)
      return Buffer.from(this.buf.subarray(from, from + n));
    return Buffer.concat([
      this.buf.subarray(from),
      this.buf.subarray(0, n - (this.capacity - from)),
    ]);
  }
}

export interface ScrollbackLogOptions {
  /** How long output waits before it is written; 0 writes on flush() only. */
  flushMs?: number;
}

export class ScrollbackLog {
  private pending: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private written: number;

  constructor(
    readonly file: string,
    readonly ring: ScrollbackRing,
    private readonly opts: ScrollbackLogOptions = {},
  ) {
    try {
      this.written = fs.statSync(file).size;
    } catch {
      this.written = 0;
    }
  }

  /** A ring holding the newest `capacity` bytes of `file` (empty if none). */
  static load(
    file: string,
    capacity: number = DEFAULT_SCROLLBACK_BYTES,
  ): ScrollbackRing {
    const ring = new ScrollbackRing(capacity);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return ring;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, capacity);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      ring.push(buf);
    } finally {
      fs.closeSync(fd);
    }
    return ring;
  }

  append(chunk: Uint8Array): void {
    this.ring.push(chunk);
    this.pending.push(Buffer.from(chunk));
    const ms = this.opts.flushMs ?? 200;
    if (ms > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, ms);
      this.timer.unref();
    }
  }

  /** Write what is pending; rewrite the log from the ring once it is too big. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending.length) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    try {
      if (this.written + data.length > 2 * this.ring.capacity) {
        const all = this.ring.snapshot();
        fs.writeFileSync(this.file, all, { mode: 0o600 });
        this.written = all.length;
      } else {
        fs.appendFileSync(this.file, data, { mode: 0o600 });
        this.written += data.length;
      }
    } catch {
      /* the ring still has it; the next flush tries again from there */
      this.written = Number.POSITIVE_INFINITY;
    }
  }

  close(): void {
    this.flush();
  }
}
