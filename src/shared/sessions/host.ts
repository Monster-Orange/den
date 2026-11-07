/**
 * The session host (AG-3a, AG spec §3): one small detached process per
 * distribution that owns every PTY and serves them on a unix socket in the
 * state dir (`<stateDir>/sessions.sock`, mode 0600). The CLI and, later,
 * the web server are its clients, so restarting the web server leaves every
 * session running. A reboot (or stopping the host) ends them; their records
 * and scrollback stay, listed as exited, until forgotten.
 *
 * Starting is idempotent: a host that finds another one answering on the
 * socket stands down ("already-running"). A socket nobody answers on is
 * stale (its host died) and is replaced. A lock file held only while
 * starting keeps two hosts from both replacing it at once.
 *
 * The host never logs or stores a session's env or argv: a record holds
 * its name, cwd, pid, times, exit code and whether it was ever prompted
 * (input with a line end written to it), never the input itself.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { DEFAULT_SCROLLBACK_BYTES, ScrollbackLog } from "./ring-buffer.js";
import { MAX_SOCKET_PATH, sessionPaths, type SessionPaths } from "./paths.js";
import {
  frame,
  LineReader,
  PROTOCOL_VERSION,
  type HostErrorCode,
  type Request,
} from "./protocol.js";
import type { PtyLoad, PtyProcess } from "./pty.js";
import {
  SESSION_POOLS,
  SESSION_SIGNALS,
  type SessionInfo,
  type SessionPool,
} from "./types.js";

export const BACKEND_ID = "den-pty";

/** A client this far behind on output is dropped (it can reattach). */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;
/** Output can trail a PTY's exit; the exit is reported after this. */
const EXIT_SETTLE_MS = 50;
const LOCK_WAIT_MS = 5000;

export interface SessionHostOptions {
  stateDir: string;
  /** The PTY module, asked at each start (it may be installed later). */
  pty: () => PtyLoad;
  scrollbackBytes?: number;
  /** Scrollback log flush delay (0: at exit and close only). */
  flushMs?: number;
  log?: (line: string) => void;
  /** Called after a `shutdown` request has closed the host. */
  onShutdown?: () => void;
}

interface Session {
  info: SessionInfo;
  cwd: string;
  pty: PtyProcess | null;
  log: ScrollbackLog;
  /** aid → its connection. */
  attachments: Map<string, Conn>;
  /** The attachments that asked for size events (attach `sizes: true`). */
  sizeAids?: Set<string>;
  /** The PTY's size: the start's, then the last resize's (any client's). */
  size?: { cols: number; rows: number };
  /** The cap it counts against (start's `pool`), when one was named. */
  pool?: SessionPool;
}

class Conn {
  readonly aids = new Set<string>();
  constructor(readonly socket: net.Socket) {}
  send(o: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(frame(o));
    if (this.socket.writableLength > MAX_BACKLOG_BYTES) this.socket.destroy();
  }
}

class Refusal extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/**
 * The cap refusal: "2 agents are running and agents.max_concurrent is 2".
 * With no pool (an older client's limit) every session counts, and the key
 * is agents.max_concurrent, as it was.
 */
function capMessage(live: number, limit: number, pool?: unknown): string {
  const noun = pool === "agents" ? "agent" : "session";
  const key = pool === "sessions" ? "sessions" : "agents";
  return `${live} ${noun}${live === 1 ? " is" : "s are"} running and ${key}.max_concurrent is ${limit}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether something answers on the socket. */
export function socketAnswers(sock: string, ms = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    const done = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), ms);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * The audit of a start's `--keep-env` names: "A, B (credential-shaped)",
 * or "" for none. Names only: a value never reaches the host's log.
 */
function keptEnvAudit(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .filter(
      (k): k is { name: string; credentialShaped?: unknown } =>
        !!k &&
        typeof (k as { name?: unknown }).name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test((k as { name: string }).name),
    )
    .map(
      (k) =>
        `${k.name}${k.credentialShaped === true ? " (credential-shaped)" : ""}`,
    )
    .join(", ");
}

/** A start's refused `--keep-env` names, printable: "A, B", or "". */
function refusedEnvAudit(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .filter(
      (k): k is string =>
        typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k),
    )
    .join(", ");
}

function printableActor(v: unknown): string {
  return (
    String(v ?? "unknown")
      .replace(/[^\x20-\x7e]/g, "")
      .slice(0, 80) || "unknown"
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SessionHost {
  readonly paths: SessionPaths;
  private readonly sessions = new Map<string, Session>();
  private readonly conns = new Set<Conn>();
  private server: net.Server | null = null;
  private readonly startedAt = new Date().toISOString();
  private closed = false;

  constructor(private readonly opts: SessionHostOptions) {
    this.paths = sessionPaths(opts.stateDir);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }

  private get capacity(): number {
    return this.opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
  }

  /** Serve on the socket, or stand down when a host already answers there. */
  async listen(): Promise<"listening" | "already-running"> {
    const { socket } = this.paths;
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH)
      throw new Error(
        `the session socket path is ${Buffer.byteLength(socket)} bytes, over the ${MAX_SOCKET_PATH}-byte limit for a unix socket: ${socket}. Use a shorter state dir.`,
      );
    fs.mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    if (await socketAnswers(socket)) return "already-running";
    if (!(await this.takeLock())) return "already-running";
    try {
      if (await socketAnswers(socket)) return "already-running";
      try {
        fs.unlinkSync(socket); // stale: nobody answers on it
        this.log(`replaced a stale socket at ${socket}`);
      } catch {
        /* none there */
      }
      this.load();
      await this.bind(socket);
      return "listening";
    } finally {
      try {
        fs.unlinkSync(this.paths.lock);
      } catch {
        /* gone */
      }
    }
  }

  /** The start lock; false when another host came up while waiting for it. */
  private async takeLock(): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.paths.lock, "wx", 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let holder = NaN;
      try {
        holder = Number(fs.readFileSync(this.paths.lock, "utf-8").trim());
      } catch {
        continue; // released between the two calls
      }
      if (
        !Number.isInteger(holder) ||
        !pidAlive(holder) ||
        Date.now() > deadline
      ) {
        try {
          fs.unlinkSync(this.paths.lock);
        } catch {
          /* someone else took it over */
        }
        continue;
      }
      if (await socketAnswers(this.paths.socket, 200)) return false;
      await sleep(50);
    }
  }

  private bind(socket: string): Promise<void> {
    const server = net.createServer((s) => this.accept(s));
    this.server = server;
    return new Promise((resolve, reject) => {
      // Owner-only from the moment the socket exists.
      const umask = process.umask(0o177);
      server.once("error", (e) => {
        process.umask(umask);
        reject(e);
      });
      server.listen(socket, () => {
        process.umask(umask);
        fs.chmodSync(socket, 0o600);
        resolve();
      });
    });
  }

  /** Records from an earlier host: their PTYs ended with it. */
  private load(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.paths.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.paths.dir, f), "utf-8"),
        ) as {
          id: string;
          name: string;
          cwd: string;
          pid: number;
          startedAt: string;
          exited?: boolean;
          exitCode?: number;
          prompted?: boolean;
        };
        if (typeof rec.id !== "string" || typeof rec.name !== "string")
          continue;
        const logFile = path.join(this.paths.dir, `${rec.id}.log`);
        const s: Session = {
          info: {
            ref: { backend: BACKEND_ID, id: rec.id },
            name: rec.name,
            pid: rec.pid,
            startedAt: rec.startedAt,
            exited: true,
            ...(typeof rec.exitCode === "number"
              ? { exitCode: rec.exitCode }
              : {}),
            ...(rec.prompted === true ? { prompted: true } : {}),
          },
          cwd: rec.cwd,
          pty: null,
          log: new ScrollbackLog(
            logFile,
            ScrollbackLog.load(logFile, this.capacity),
            {
              flushMs: this.opts.flushMs,
            },
          ),
          attachments: new Map(),
        };
        this.sessions.set(rec.id, s);
        if (!rec.exited) this.persist(s);
      } catch {
        /* an unreadable record is skipped, not fatal */
      }
    }
  }

  private persist(s: Session): void {
    const rec = {
      id: s.info.ref.id,
      name: s.info.name,
      cwd: s.cwd,
      pid: s.info.pid,
      startedAt: s.info.startedAt,
      ...(s.info.exited ? { exited: true } : {}),
      ...(s.info.exitCode !== undefined ? { exitCode: s.info.exitCode } : {}),
      ...(s.info.prompted ? { prompted: true } : {}),
    };
    try {
      fs.writeFileSync(
        path.join(this.paths.dir, `${s.info.ref.id}.json`),
        JSON.stringify(rec, null, 2) + "\n",
        { mode: 0o600 },
      );
    } catch (e) {
      this.log(
        `could not save session ${s.info.ref.id}: ${(e as Error).message}`,
      );
    }
  }

  private accept(socket: net.Socket): void {
    const conn = new Conn(socket);
    this.conns.add(conn);
    const reader = new LineReader((line) => this.onLine(conn, line));
    socket.on("data", (chunk) => {
      if (!reader.push(chunk)) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const aid of conn.aids)
        for (const s of this.sessions.values()) s.attachments.delete(aid);
      this.conns.delete(conn);
    });
  }

  private onLine(conn: Conn, line: string): void {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      conn.send({
        id: null,
        ok: false,
        code: "bad-request",
        error: "not JSON",
      });
      return;
    }
    const id = typeof req?.id === "number" ? req.id : null;
    try {
      if (req.op === "shutdown") {
        conn.send({ id, ok: true });
        setImmediate(() => {
          void this.close().then(() => this.opts.onShutdown?.());
        });
        return;
      }
      if (req.v !== PROTOCOL_VERSION)
        throw new Refusal(
          "protocol",
          `this session host speaks protocol v${PROTOCOL_VERSION}, the client v${String(req.v)}`,
        );
      conn.send({ id, ok: true, ...this.dispatch(conn, req) });
    } catch (e) {
      conn.send({
        id,
        ok: false,
        code: e instanceof Refusal ? e.code : "bad-request",
        error: (e as Error).message,
      });
    }
  }

  private session(ref: unknown): Session {
    const s = typeof ref === "string" ? this.sessions.get(ref) : undefined;
    if (!s)
      throw new Refusal("not-found", `no session with id "${String(ref)}"`);
    return s;
  }

  private dispatch(conn: Conn, req: Request): Record<string, unknown> {
    switch (req.op) {
      case "hello":
        return {
          v: PROTOCOL_VERSION,
          pid: process.pid,
          startedAt: this.startedAt,
        };
      case "list":
        return {
          sessions: [...this.sessions.values()]
            .map((s) => s.info)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
        };
      case "start":
        return { info: this.start(req) };
      case "attach":
        return { info: this.attach(conn, req) };
      case "detach": {
        const aid = String(req.aid);
        conn.aids.delete(aid);
        for (const s of this.sessions.values()) s.attachments.delete(aid);
        return {};
      }
      case "write": {
        const s = this.session(req.ref);
        if (s.pty && !s.info.exited && typeof req.data === "string") {
          const bytes = Buffer.from(req.data, "base64");
          s.pty.write(bytes);
          // A line end is a prompt sent; a terminal's own replies to the
          // program's queries (escape sequences) carry none.
          if (
            !s.info.prompted &&
            (bytes.includes(0x0d) || bytes.includes(0x0a))
          ) {
            s.info.prompted = true;
            this.persist(s);
          }
        }
        return {};
      }
      case "resize": {
        const s = this.session(req.ref);
        if (!isInt(req.cols, 1, 10_000) || !isInt(req.rows, 1, 10_000))
          throw new Refusal("bad-request", "resize needs whole cols and rows");
        if (s.pty && !s.info.exited) {
          s.pty.resize(req.cols, req.rows);
          // Last writer wins: every viewer that asked hears the new size,
          // so one out of step knows to say its own again.
          if (s.size?.cols !== req.cols || s.size?.rows !== req.rows) {
            s.size = { cols: req.cols, rows: req.rows };
            this.sendSize(s);
          }
        }
        return {};
      }
      case "signal": {
        const s = this.session(req.ref);
        const sig = String(req.signal);
        if (!(SESSION_SIGNALS as readonly string[]).includes(sig))
          throw new Refusal(
            "bad-request",
            `signal must be one of ${SESSION_SIGNALS.join(", ")}`,
          );
        if (s.info.exited || !s.pty)
          throw new Refusal("exited", `${s.info.name} has already exited`);
        s.pty.kill(`SIG${sig}`);
        return {};
      }
      case "scrollback": {
        const s = this.session(req.ref);
        const max = isInt(req.max, 0, Number.MAX_SAFE_INTEGER)
          ? req.max
          : this.capacity;
        return { data: s.log.ring.snapshot(max).toString("base64") };
      }
      case "forget": {
        const s = this.session(req.ref);
        if (!s.info.exited)
          throw new Refusal(
            "bad-request",
            `${s.info.name} is running: kill it first`,
          );
        this.forget(s);
        return {};
      }
      default:
        throw new Refusal("bad-request", `unknown op "${String(req.op)}"`);
    }
  }

  private forget(s: Session): void {
    this.sessions.delete(s.info.ref.id);
    for (const ext of [".json", ".log"])
      try {
        fs.unlinkSync(path.join(this.paths.dir, `${s.info.ref.id}${ext}`));
      } catch {
        /* never written */
      }
  }

  private start(req: Request): SessionInfo {
    const spec = (req.spec ?? {}) as Record<string, unknown>;
    const { name, cwd, argv, env } = spec;
    if (typeof name !== "string" || !name)
      throw new Refusal("bad-request", "start needs a name");
    // SEC-1 §5: a --keep-env the caller refused (a person's credential) is
    // audited here, names only, and nothing starts.
    const refusedEnv = refusedEnvAudit(req.refusedEnv);
    if (refusedEnv || Array.isArray(req.refusedEnv)) {
      this.log(
        `session ${printableActor(name)} refused: --keep-env ${refusedEnv || "?"} (a person's credential is never forwarded) · by ${printableActor(req.actor)}`,
      );
      throw new Refusal(
        "bad-request",
        `--keep-env ${refusedEnv || "?"}: a person's credential is never forwarded to a session`,
      );
    }
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((a): a is string => typeof a === "string")
    )
      throw new Refusal("bad-request", "start needs an argv of strings");
    if (
      typeof cwd !== "string" ||
      !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()
    )
      throw new Refusal(
        "bad-request",
        `cwd "${String(cwd)}" is not a directory`,
      );
    if (
      !env ||
      typeof env !== "object" ||
      !Object.values(env).every((v) => typeof v === "string")
    )
      throw new Refusal("bad-request", "start needs an env of strings");
    const cols = isInt(spec.cols, 1, 10_000) ? spec.cols : 80;
    const rows = isInt(spec.rows, 1, 10_000) ? spec.rows : 24;

    const same = [...this.sessions.values()].filter(
      (s) => s.info.name === name,
    );
    if (same.some((s) => !s.info.exited))
      throw new Refusal("exists", `${name} is already running`);
    // A cap counts its own pool's running sessions: agents.max_concurrent
    // the agents, sessions.max_concurrent the plain ones. A limit with no
    // pool (an older client) counts every running session, as before.
    const pool = req.pool;
    if (pool !== undefined && !SESSION_POOLS.includes(pool as SessionPool))
      throw new Refusal(
        "bad-request",
        `pool must be ${SESSION_POOLS.join(" or ")}`,
      );
    if (req.limit !== undefined) {
      if (!isInt(req.limit, 1, 100_000))
        throw new Refusal(
          "bad-request",
          "limit must be a whole number of at least 1",
        );
      const live = [...this.sessions.values()].filter(
        (s) => !s.info.exited && (pool === undefined || s.pool === pool),
      ).length;
      if (live >= req.limit)
        throw new Refusal("cap", capMessage(live, req.limit, pool));
    }
    const load = this.opts.pty();
    if (!load.available) throw new Refusal("unavailable", load.reason);

    let pty: PtyProcess;
    try {
      pty = load.factory(argv[0], argv.slice(1), {
        cwd,
        env: env as Record<string, string>,
        cols,
        rows,
      });
    } catch (e) {
      throw new Refusal(
        "spawn",
        `could not start ${argv[0]}: ${(e as Error).message}`,
      );
    }
    for (const s of same) this.forget(s);

    let id = randomBytes(4).toString("hex");
    while (this.sessions.has(id)) id = randomBytes(4).toString("hex");
    const logFile = path.join(this.paths.dir, `${id}.log`);
    const s: Session = {
      info: {
        ref: { backend: BACKEND_ID, id },
        name,
        pid: pty.pid,
        startedAt: new Date().toISOString(),
      },
      cwd,
      pty,
      log: new ScrollbackLog(
        logFile,
        ScrollbackLog.load(logFile, this.capacity),
        {
          flushMs: this.opts.flushMs,
        },
      ),
      attachments: new Map(),
      size: { cols, rows },
      ...(pool !== undefined ? { pool: pool as SessionPool } : {}),
    };
    this.sessions.set(id, s);
    this.persist(s);
    pty.onData((d) => {
      s.log.append(d);
      if (!s.attachments.size) return;
      const data = d.toString("base64");
      for (const [aid, c] of s.attachments) c.send({ ev: "data", aid, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      setTimeout(() => {
        s.info.exited = true;
        s.info.exitCode = signal ? 128 + signal : exitCode;
        s.pty = null;
        s.log.flush();
        if (this.sessions.get(id) === s) this.persist(s);
        for (const [aid, c] of s.attachments)
          c.send({ ev: "exit", aid, exitCode: s.info.exitCode });
        s.attachments.clear();
        s.sizeAids?.clear();
        this.log(`session ${id} (${name}) exited (${s.info.exitCode})`);
      }, EXIT_SETTLE_MS);
    });
    this.log(`session ${id} (${name}) started, pid ${pty.pid}`);
    const kept = keptEnvAudit(req.keptEnv);
    if (kept)
      this.log(
        `session ${id} (${name}) --keep-env ${kept} · by ${printableActor(req.actor)}`,
      );
    return s.info;
  }

  private attach(conn: Conn, req: Request): SessionInfo {
    const s = this.session(req.ref);
    const aid = typeof req.aid === "string" ? req.aid : "";
    if (!aid || conn.aids.has(aid))
      throw new Refusal("bad-request", "attach needs a new aid");
    const max = isInt(req.replay, 0, Number.MAX_SAFE_INTEGER)
      ? req.replay
      : this.capacity;
    const replay = s.log.ring.snapshot(max);
    if (replay.length)
      conn.send({ ev: "data", aid, data: replay.toString("base64") });
    if (s.info.exited) {
      conn.send({ ev: "exit", aid, exitCode: s.info.exitCode });
    } else {
      conn.aids.add(aid);
      s.attachments.set(aid, conn);
      if (req.sizes === true) {
        (s.sizeAids ??= new Set()).add(aid);
        if (s.size) conn.send({ ev: "size", aid, ...s.size });
      }
    }
    return s.info;
  }

  /** Tell each attachment that asked the session's current size. */
  private sendSize(s: Session): void {
    if (!s.size || !s.sizeAids?.size) return;
    for (const aid of s.sizeAids) {
      const c = s.attachments.get(aid);
      if (c) c.send({ ev: "size", aid, ...s.size });
      else s.sizeAids.delete(aid);
    }
  }

  /** Stop serving: running sessions get SIGHUP, scrollback is flushed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sessions.values()) {
      if (s.pty && !s.info.exited) {
        try {
          s.pty.kill("SIGHUP");
        } catch {
          /* gone */
        }
      }
      s.log.flush();
    }
    for (const c of this.conns) c.socket.destroy();
    const server = this.server;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * `<cli> sessions host`: serve until stopped (SIGTERM, SIGINT, or a
 * `shutdown` request). Resolves 0 once listening, or at once when a host is
 * already running; 1 when it cannot listen.
 */
export async function runSessionHost(
  opts: Omit<SessionHostOptions, "onShutdown">,
): Promise<number> {
  const log =
    opts.log ??
    ((l: string) => console.log(`${new Date().toISOString()} ${l}`));
  const host = new SessionHost({
    ...opts,
    log,
    onShutdown: () => process.exit(0),
  });
  let state: "listening" | "already-running";
  try {
    state = await host.listen();
  } catch (e) {
    log(`session host could not start: ${(e as Error).message}`);
    return 1;
  }
  if (state === "already-running") {
    log(`a session host is already running on ${host.paths.socket}`);
    return 0;
  }
  const stop = () => void host.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // No terminal to hang up on: it was started detached.
  process.on("SIGHUP", () => undefined);
  log(`session host ${process.pid} listening on ${host.paths.socket}`);
  return 0;
}
