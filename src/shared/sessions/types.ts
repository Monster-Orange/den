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
  /**
   * Set once input ending a line (Enter) has been written to it: someone
   * prompted it. A runtime with nothing to resume until then (den-claude)
   * starts afresh instead. Never what was typed.
   */
  prompted?: boolean;
  /**
   * D20: the launchd session its host ran in (`launchctl managername`):
   * Aqua ends at logout, Background survives it. Absent off macOS.
   */
  launchd?: string;
  /**
   * NT-1: when its output last asked for attention the terminal's way (a
   * bare BEL, OSC 9, OSC 777;notify), ISO 8601. Since this host started.
   */
  bellAt?: string;
}

/**
 * The cap a start counts against: `agents` (agents.max_concurrent) or
 * `sessions` (sessions.max_concurrent, the plain ones), each counting only
 * its own running sessions.
 */
export const SESSION_POOLS = ["agents", "sessions"] as const;
export type SessionPool = (typeof SESSION_POOLS)[number];

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
  /**
   * The PTY's size: once on attach (after the replay), then each time any
   * client resizes it. The size is last-writer-wins across every viewer,
   * so a viewer learns here that another one changed it.
   */
  onSize?(cols: number, rows: number): void;
}

/** One attachment; a session has any number, each gets all the output. */
export interface Attachment {
  /** Settles once the replay has been delivered and live output follows. */
  readonly ready: Promise<SessionInfo>;
  /** Stop receiving output. The session keeps running. */
  detach(): void;
}

export type SessionSignal = "INT" | "TERM" | "HUP" | "KILL";
export const SESSION_SIGNALS: readonly SessionSignal[] = [
  "INT",
  "TERM",
  "HUP",
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
