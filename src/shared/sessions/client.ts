/**
 * A client of the session host (protocol.ts): one socket connection, many
 * requests and attachments over it. ensureHost starts a host on demand when
 * none answers (the first client starts it; later ones find it).
 */
import { EventEmitter } from "events";
import * as net from "net";
import {
  frame,
  LineReader,
  PROTOCOL_VERSION,
  type HostErrorCode,
  type HostEvent,
} from "./protocol.js";
import type {
  AttachHandlers,
  Attachment,
  SessionInfo,
  SessionPool,
  SessionSignal,
  SessionSpec,
} from "./types.js";

/** A request the host refused. */
export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode | "closed",
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
}

let aidSeq = 0;

export class HostClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly attachments = new Map<string, AttachHandlers>();
  hostPid = 0;
  hostStartedAt = "";

  constructor(private readonly socket: net.Socket) {
    super();
    const reader = new LineReader((line) => this.onLine(line));
    socket.on("data", (c) => {
      if (!reader.push(c)) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const p of this.pending.values())
        p.reject(
          new HostError("closed", "the session host closed the connection"),
        );
      this.pending.clear();
      this.attachments.clear();
      this.emit("close");
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.ev === "string") {
      const ev = msg as unknown as HostEvent;
      const h = this.attachments.get(ev.aid);
      if (!h) return;
      if (ev.ev === "data") h.onData(Buffer.from(ev.data, "base64"));
      else if (ev.ev === "size") h.onSize?.(ev.cols, ev.rows);
      else if (ev.ev === "exit") {
        this.attachments.delete(ev.aid);
        h.onExit?.(ev.exitCode);
      }
      return;
    }
    const p = this.pending.get(msg.id as number);
    if (!p) return;
    this.pending.delete(msg.id as number);
    if (msg.ok) p.resolve(msg);
    else
      p.reject(
        new HostError(
          msg.code as HostErrorCode,
          String(msg.error ?? "refused"),
        ),
      );
  }

  /** Send one request; resolves with the host's reply. */
  request(
    op: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.socket.destroyed)
      return Promise.reject(
        new HostError("closed", "not connected to the session host"),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(frame({ v: PROTOCOL_VERSION, id, op, ...body }));
    });
  }

  /** Fire and forget: errors are dropped (write, resize, signal). */
  private send(op: string, body: Record<string, unknown>): void {
    this.request(op, body).catch(() => undefined);
  }

  async hello(): Promise<void> {
    const r = await this.request("hello");
    this.hostPid = Number(r.pid);
    this.hostStartedAt = String(r.startedAt ?? "");
  }

  async start(
    spec: SessionSpec,
    opts: {
      limit?: number;
      /**
       * Which running sessions `limit` counts: agents (agents.max_concurrent)
       * or plain ones (sessions.max_concurrent). Without it, all of them.
       */
      pool?: SessionPool;
      /** `--keep-env` names, for the host's audit line (never values). */
      keptEnv?: { name: string; credentialShaped: boolean }[];
      /** Who asked, for that line. */
      actor?: string;
      /**
       * `--keep-env` names Den refuses to forward (SEC-1 §5: a person's
       * credential): the host records the refusal and starts nothing.
       */
      refusedEnv?: string[];
    } = {},
  ): Promise<SessionInfo> {
    const r = await this.request("start", {
      spec,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.pool !== undefined ? { pool: opts.pool } : {}),
      ...(opts.keptEnv?.length || opts.refusedEnv?.length
        ? { actor: opts.actor ?? "unknown" }
        : {}),
      ...(opts.keptEnv?.length ? { keptEnv: opts.keptEnv } : {}),
      ...(opts.refusedEnv?.length ? { refusedEnv: opts.refusedEnv } : {}),
    });
    return r.info as SessionInfo;
  }

  async list(): Promise<SessionInfo[]> {
    return (await this.request("list")).sessions as SessionInfo[];
  }

  /**
   * Attach to session `id`: the replay (the newest `replay` bytes, all of
   * the scrollback by default) arrives first, then live output.
   */
  attach(
    id: string,
    handlers: AttachHandlers,
    opts: { replay?: number } = {},
  ): Attachment {
    const aid = `${process.pid}.${++aidSeq}`;
    this.attachments.set(aid, handlers);
    const ready = this.request("attach", {
      ref: id,
      aid,
      ...(opts.replay !== undefined ? { replay: opts.replay } : {}),
      // Only a client that handles them is sent size events: an older
      // client would read an unknown event as the session's exit.
      ...(handlers.onSize ? { sizes: true } : {}),
    }).then(
      (r) => r.info as SessionInfo,
      (e: Error) => {
        this.attachments.delete(aid);
        throw e;
      },
    );
    return {
      ready,
      detach: () => {
        this.attachments.delete(aid);
        this.send("detach", { aid });
      },
    };
  }

  write(id: string, bytes: Uint8Array): void {
    this.send("write", {
      ref: id,
      data: Buffer.from(bytes).toString("base64"),
    });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send("resize", { ref: id, cols, rows });
  }

  signal(id: string, signal: SessionSignal): void {
    this.send("signal", { ref: id, signal });
  }

  /** Like signal, but says when the host refused (exited, unknown). */
  async kill(id: string, signal: SessionSignal): Promise<void> {
    await this.request("signal", { ref: id, signal });
  }

  async scrollback(id: string, max: number): Promise<Buffer> {
    const r = await this.request("scrollback", { ref: id, max });
    return Buffer.from(String(r.data ?? ""), "base64");
  }

  async forget(id: string): Promise<void> {
    await this.request("forget", { ref: id });
  }

  /** Stop the host: every running session ends. */
  async shutdown(): Promise<void> {
    await this.request("shutdown");
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

/** Whether a connect error means no host is serving on the socket. */
export function noHost(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Connect to the host on `socket` and say hello (checks the protocol). */
export function connectHost(socket: string): Promise<HostClient> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socket);
    const fail = (e: Error) => reject(e);
    s.once("error", fail);
    s.once("connect", () => {
      s.off("error", fail);
      const c = new HostClient(s);
      c.hello().then(
        () => resolve(c),
        (e: Error) => {
          c.close();
          reject(e);
        },
      );
    });
  });
}

export interface EnsureHostOptions {
  socket: string;
  /** Start a host in the background (detached, its own process group). */
  spawnHost: () => void;
  /** How long a new host gets to answer (default 15 s). */
  timeoutMs?: number;
  /** Named in the timeout error: where the host writes its log. */
  logHint?: string;
}

/** A client of the running host, started first when none answers. */
export async function ensureHost(o: EnsureHostOptions): Promise<HostClient> {
  try {
    return await connectHost(o.socket);
  } catch (e) {
    if (!noHost(e)) throw e;
  }
  o.spawnHost();
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      return await connectHost(o.socket);
    } catch (e) {
      if (!noHost(e)) throw e;
      if (Date.now() > deadline)
        throw new Error(
          `the session host did not start within ${Math.round((o.timeoutMs ?? 15_000) / 1000)}s` +
            (o.logHint ? `: see ${o.logHint}` : ""),
        );
    }
  }
}
