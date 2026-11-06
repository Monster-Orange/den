/**
 * The session backend contract (strategy kind `session-backend`, AG spec
 * §2). A backend starts an argv in a cwd with an env and keeps its PTY; it
 * knows nothing about agents, personas or runtimes. Den maps a session to
 * its agent (AG-2a); the backend never does.
 *
 * Session names are `<dist>-<workspace>:<name>` (names.ts), so two
 * distributions on one machine never collide.
 */

/** Which backend holds a session, and its id there. */
export interface SessionRef {
  backend: string;
  id: string;
}

/** A session as a backend lists it. */
export interface SessionInfo {
  ref: SessionRef;
  /** `<dist>-<workspace>:<name>`. */
  name: string;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  exited?: boolean;
  exitCode?: number;
}

/** What to run. `env` is the whole environment: nothing is inherited. */
export interface SessionSpec {
  name: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface AttachHandlers {
  /** Output, scrollback replay first. */
  onData(data: Buffer): void;
  /** The session ended (at once, after the replay, when it already had). */
  onExit?(exitCode: number | undefined): void;
}

/** One attachment; a session has any number, each gets all the output. */
export interface Attachment {
  /** Settles once the replay has been delivered and live output follows. */
  readonly ready: Promise<SessionInfo>;
  /** Stop receiving output. The session keeps running. */
  detach(): void;
}

export type SessionSignal = "INT" | "TERM" | "KILL";
export const SESSION_SIGNALS: readonly SessionSignal[] = [
  "INT",
  "TERM",
  "KILL",
];

export interface SessionBackend {
  /** "den-pty", "tmux". */
  readonly id: string;
  start(spec: SessionSpec): Promise<SessionRef>;
  /** Survives a web server restart: the sessions live elsewhere. */
  list(): Promise<SessionInfo[]>;
  attach(ref: SessionRef, handlers: AttachHandlers): Attachment;
  write(ref: SessionRef, bytes: Uint8Array): void;
  resize(ref: SessionRef, cols: number, rows: number): void;
  signal(ref: SessionRef, signal: SessionSignal): void;
  /** The newest `maxBytes` of output, for a replay on attach. */
  scrollback(ref: SessionRef, maxBytes: number): Promise<Uint8Array>;
  /** A command a person can run to attach outside Den (tmux), or null. */
  externalAttach?(ref: SessionRef): string | null;
}
