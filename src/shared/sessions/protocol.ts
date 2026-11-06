/**
 * The session host's wire protocol, version 1: newline-delimited JSON over
 * the host's unix socket, both ways. Terminal bytes travel base64 in `data`.
 *
 *   request   {v, id, op, ...}            client → host
 *   reply     {id, ok: true, ...}         host → client, one per request
 *             {id, ok: false, code, error}
 *   event     {ev: "data", aid, data}     host → client, per attachment
 *             {ev: "exit", aid, exitCode}
 *
 * ops: hello, start, list, attach, detach, write, resize, signal,
 * scrollback, forget, shutdown. A request whose `v` is not the host's is
 * refused with code "protocol", except `shutdown`, which every version
 * takes, so an older host can always be stopped.
 *
 * An attach reply comes after its replay: once a client has the reply, the
 * scrollback has been delivered and live output follows, with no gap and
 * nothing twice.
 */
import { StringDecoder } from "string_decoder";

export const PROTOCOL_VERSION = 1;

/** A line longer than this ends the connection (a replay is ~2.7 MB). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type HostErrorCode =
  | "protocol"
  | "bad-request"
  | "not-found"
  | "exists"
  | "cap"
  | "unavailable"
  | "spawn"
  | "exited";

export interface Request {
  v: number;
  id: number;
  op: string;
  [key: string]: unknown;
}

export type Reply =
  | ({ id: number; ok: true } & Record<string, unknown>)
  | { id: number; ok: false; code: HostErrorCode; error: string };

export type HostEvent =
  | { ev: "data"; aid: string; data: string }
  | { ev: "exit"; aid: string; exitCode?: number };

/** Splits a byte stream into lines; refuses one that grows too long. */
export class LineReader {
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly onLine: (line: string) => void) {}

  /** Returns false once a line is too long: drop the connection. */
  push(chunk: Buffer | string): boolean {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    return this.buf.length <= MAX_LINE_BYTES;
  }
}

export const frame = (o: unknown): string => JSON.stringify(o) + "\n";
