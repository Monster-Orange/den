/**
 * Issue 988, slice 2: the runtime sign-in token's way into a session that
 * runs under the agents' own OS login.
 *
 * Why the terminal: sudo (and launchctl) close every file descriptor above
 * 2 when they switch to the other login, so no pipe Den opens survives into
 * the session. A token in argv shows in `ps`; one in a file stays where the
 * login could read it later; the launcher starts with `env -i`. The
 * session's own terminal is the one channel that reaches it, so:
 *
 *   1. `agents session` turns echo off (raw mode), drops any input already
 *      waiting, and prints a ready marker with Den's per-launch nonce.
 *   2. Den's host, which holds every other input to that session until
 *      then, sees its marker (stripped from the output) and writes the
 *      token as one line, past every input recorder.
 *   3. `agents session` reads that line (at most TOKEN_LINE_MAX bytes,
 *      within the timeout), turns echo back on, and puts the token only in
 *      the runtime's env.
 *
 * A marker with another nonce, or a second one, ends the launch with no
 * token written: the output can't forge it.
 */
import { randomBytes } from "crypto";

/** The command these messages come from. */
const CMD = "agents session"; // words-ok: the CLI command's own name

/** The longest token line read: a sign-in token is far shorter. */
export const TOKEN_LINE_MAX = 4096;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** A token: printable ASCII, no space. */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const MARK_HEAD = "\u001b]den-ready;";
const MARK_TAIL = "\u0007";
const MARK_LEN = MARK_HEAD.length + 32 + MARK_TAIL.length;

/** A fresh nonce for one launch. */
export function newLaunchNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The marker `agents session` prints when it is ready (an OSC string). */
export function readyMarker(nonce: string): string {
  return `${MARK_HEAD}${nonce}${MARK_TAIL}`;
}

type TtyIn = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  read: (size?: number) => string | Buffer | null;
  unshift: (chunk: Buffer) => void;
};

export interface ReadTokenOptions {
  /** Den's per-launch nonce (from the launcher's argv). */
  nonce: string;
  /** How long Den has to write the line (default 5 s). */
  timeoutMs?: number;
  /** How long input already on its way is dropped before the marker. */
  settleMs?: number;
}

/**
 * `agents session`: the token line from the terminal on `input`. Echo is
 * off from before the marker until the line is read (or refused).
 */
export async function readTokenLine(
  input: NodeJS.ReadableStream,
  write: (text: string) => void,
  o: ReadTokenOptions,
): Promise<string> {
  const tty = input as TtyIn;
  if (!tty.isTTY || typeof tty.setRawMode !== "function")
    throw new Error(
      `${CMD}: stdin is not a terminal, so echo can't be turned off for the token`,
    );
  if (!NONCE_RE.test(o.nonce))
    throw new Error(`${CMD}: the launch nonce is not Den's shape`);
  tty.setRawMode(true);
  try {
    // Drop what was typed before: it is never the token.
    const drop = () => {
      while (tty.read() !== null) {
        /* dropped */
      }
    };
    drop();
    tty.on("readable", drop);
    await new Promise((r) => setTimeout(r, o.settleMs ?? 100));
    tty.removeListener("readable", drop);
    drop();
    write(readyMarker(o.nonce));
    return await new Promise<string>((resolve, reject) => {
      let got = Buffer.alloc(0);
      const done = (err: Error | null, line?: string) => {
        clearTimeout(timer);
        tty.removeListener("readable", onData);
        if (err) reject(err);
        else resolve(line!);
      };
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `${CMD}: no token within ${Math.round((o.timeoutMs ?? 5000) / 1000) || 1} s`,
            ),
          ),
        o.timeoutMs ?? 5000,
      );
      const onData = () => {
        let c: string | Buffer | null;
        while ((c = tty.read()) !== null) {
          got = Buffer.concat([got, Buffer.isBuffer(c) ? c : Buffer.from(c)]);
          const end = got.findIndex((b) => b === 0x0a || b === 0x0d);
          if (end === -1) {
            if (got.length > TOKEN_LINE_MAX)
              return done(
                new Error(
                  `${CMD}: the token line is longer than ${TOKEN_LINE_MAX} bytes`,
                ),
              );
            continue;
          }
          if (end > TOKEN_LINE_MAX)
            return done(
              new Error(
                `${CMD}: the token line is longer than ${TOKEN_LINE_MAX} bytes`,
              ),
            );
          const line = got.subarray(0, end).toString("latin1");
          const rest = got.subarray(end + 1);
          // What follows stays for the runtime.
          if (rest.length) tty.unshift(rest);
          if (!TOKEN_RE.test(line))
            return done(new Error(`${CMD}: that line is not a token`));
          return done(null, line);
        }
      };
      tty.on("readable", onData);
      onData();
    });
  } finally {
    tty.setRawMode(false);
  }
}

export type ReadyState = "waiting" | "ready" | "refused";

/**
 * Den's host: watches a session's output for its marker. `show` is what
 * reaches the transcript (never a marker); `ready` once its own marker
 * came; `refused` for another nonce's or a second one, before or after
 * the token was written (the launch ends; nothing more is written). The
 * nonce shows in `ps` (the launcher's argv), so it is good for one write.
 */
export function watchReady(nonce: string): {
  feed: (chunk: string) => { show: string; state: ReadyState };
  /**
   * True once, when its own marker came and nothing was refused: the host
   * writes the token then, and never again for this nonce (single use).
   */
  take: () => boolean;
} {
  let state: ReadyState = "waiting";
  let held = "";
  let taken = false;
  return {
    take() {
      if (state !== "ready" || taken) return false;
      taken = true;
      return true;
    },
    feed(chunk) {
      let text = held + chunk;
      held = "";
      let show = "";
      for (;;) {
        const at = text.indexOf(MARK_HEAD);
        if (at === -1) break;
        if (text.length < at + MARK_LEN) {
          // A marker cut off at the chunk's end: wait for the rest.
          show += text.slice(0, at);
          held = text.slice(at);
          text = "";
          break;
        }
        const got = text.slice(at, at + MARK_LEN);
        show += text.slice(0, at);
        text = text.slice(at + MARK_LEN);
        state =
          state === "waiting" && got === readyMarker(nonce) ? "ready" : "refused";
      }
      // A tail that could start a marker is held for the next chunk.
      for (let k = Math.min(MARK_HEAD.length - 1, text.length); k > 0; k--)
        if (MARK_HEAD.startsWith(text.slice(-k))) {
          held = text.slice(-k) + held;
          text = text.slice(0, -k);
          break;
        }
      return { show: show + text, state };
    },
  };
}
