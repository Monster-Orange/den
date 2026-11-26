import { randomBytes } from "crypto";

const CMD = "`agents session`";

export const TOKEN_LINE_MAX = 4096;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[\x21-\x7e]+$/;
const MARK_HEAD = "\u001b]den-ready;";
const MARK_TAIL = "\u0007";
const MARK_LEN = MARK_HEAD.length + 32 + MARK_TAIL.length;

export function newLaunchNonce(): string {
  return randomBytes(16).toString("hex");
}

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
  nonce: string;
  timeoutMs?: number;
  settleMs?: number;
}

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
    const drop = () => {
      while (tty.read() !== null) {}
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

export function watchReady(nonce: string): {
  feed: (chunk: string) => { show: string; state: ReadyState };
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
          show += text.slice(0, at);
          held = text.slice(at);
          text = "";
          break;
        }
        const got = text.slice(at, at + MARK_LEN);
        show += text.slice(0, at);
        text = text.slice(at + MARK_LEN);
        state =
          state === "waiting" && got === readyMarker(nonce)
            ? "ready"
            : "refused";
      }
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
