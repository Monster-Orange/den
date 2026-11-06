/**
 * den-pty: Den's built-in session backend (AG-3a). Its sessions live in the
 * session host (host.ts), and this side is a client of it, so whoever holds
 * a DenPtyBackend (the CLI now, the web server from AG-4a) can restart
 * without ending a session.
 *
 * Registered as strategy kind `session-backend`, so `<cli> doctor` shows
 * whether it can work here and why not. A workspace picking a backend in
 * config (`sessions.backend`) comes with the second backend (tmux, AG-3b);
 * until then den-pty is the implicit choice.
 */
import {
  registerStrategy,
  type StrategyEntry,
} from "../strategies/registry.js";
import type { HostClient } from "./client.js";
import { BACKEND_ID } from "./host.js";
import { loadPty, type PtyLoad } from "./pty.js";
import type {
  AttachHandlers,
  Attachment,
  SessionBackend,
  SessionInfo,
  SessionRef,
  SessionSignal,
  SessionSpec,
} from "./types.js";

export const SESSION_BACKEND_KIND = "session-backend";
export { BACKEND_ID as DEN_PTY_ID };

export interface DenPtyOptions {
  /** A client of the running host (ensureHost). */
  client: HostClient;
  /** Applied to every start: agents.max_concurrent. */
  limit?: number;
}

export class DenPtyBackend implements SessionBackend {
  readonly id = BACKEND_ID;
  constructor(private readonly opts: DenPtyOptions) {}

  private own(ref: SessionRef): string {
    if (ref.backend !== BACKEND_ID)
      throw new Error(
        `session ${ref.id} belongs to ${ref.backend}, not ${BACKEND_ID}`,
      );
    return ref.id;
  }

  async start(spec: SessionSpec): Promise<SessionRef> {
    return (await this.opts.client.start(spec, { limit: this.opts.limit })).ref;
  }
  list(): Promise<SessionInfo[]> {
    return this.opts.client.list();
  }
  attach(ref: SessionRef, handlers: AttachHandlers): Attachment {
    return this.opts.client.attach(this.own(ref), handlers);
  }
  write(ref: SessionRef, bytes: Uint8Array): void {
    this.opts.client.write(this.own(ref), bytes);
  }
  resize(ref: SessionRef, cols: number, rows: number): void {
    this.opts.client.resize(this.own(ref), cols, rows);
  }
  signal(ref: SessionRef, signal: SessionSignal): void {
    this.opts.client.signal(this.own(ref), signal);
  }
  async scrollback(ref: SessionRef, maxBytes: number): Promise<Uint8Array> {
    return this.opts.client.scrollback(this.own(ref), maxBytes);
  }
  externalAttach(): string | null {
    return null;
  }
}

export interface SessionBackendCapabilities {
  /** Whether the backend can start sessions here (the PTY module). */
  pty(): PtyLoad;
}

const denPty: StrategyEntry<
  typeof SESSION_BACKEND_KIND,
  SessionBackendCapabilities
> = {
  id: BACKEND_ID,
  kind: SESSION_BACKEND_KIND,
  detect() {
    const load = loadPty();
    return load.available
      ? { available: true, reason: "PTY module loaded" }
      : { available: false, reason: load.reason };
  },
  capabilities: { pty: () => loadPty() },
};

registerStrategy(denPty);
