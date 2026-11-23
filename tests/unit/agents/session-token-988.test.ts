/**
 * Issue 988, slice 2: the runtime sign-in token reaches a session started
 * under the agents' own login as one line on its terminal. A session runs
 * in a PTY (sudo closes every fd above 2, so no pipe survives the switch to
 * the other login), so `agents session` first turns echo off, drops any
 * input already typed, and prints a ready marker carrying Den's per-launch
 * nonce. Only then does Den write the token. Never argv, a file or the
 * launcher's env. A line that is too long, or late, is refused; a marker
 * with the wrong nonce, or a second one, ends the launch.
 */
import { describe, expect, it } from "@jest/globals";
import { PassThrough } from "stream";
import {
  TOKEN_LINE_MAX,
  newLaunchNonce,
  readTokenLine,
  readyMarker,
  watchReady,
} from "../../../src/shared/agents/session-token.js";

/** A terminal-like stdin: records raw mode on and off, in order. */
function tty() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (on: boolean) => void;
  };
  const modes: boolean[] = [];
  s.isTTY = true;
  s.setRawMode = (on) => {
    modes.push(on);
  };
  return { s, modes };
}

const N = "0123456789abcdef0123456789abcdef";
const opts = { nonce: N, timeoutMs: 1000, settleMs: 20 };

describe("issue 988: the session reads the token", () => {
  it("echo off, early input dropped, then the marker; one line read; echo back on", async () => {
    const { s, modes } = tty();
    s.write("typed-early\n");
    const said: string[] = [];
    const p = readTokenLine(s, (t) => said.push(`${modes.length}:${t}`), opts);
    await new Promise((r) => setTimeout(r, 60));
    // The marker went out after raw mode was on, and after the drop.
    expect(said).toEqual([`1:${readyMarker(N)}`]);
    s.write("tok-123\nrest");
    await expect(p).resolves.toBe("tok-123");
    expect(modes).toEqual([true, false]);
    // What came after the line stays for the runtime.
    expect(String(s.read())).toBe("rest");
  });

  it("a carriage return ends the line too (a terminal in raw mode)", async () => {
    const { s } = tty();
    const p = readTokenLine(s, () => {}, opts);
    await new Promise((r) => setTimeout(r, 40));
    s.write("tok\r");
    await expect(p).resolves.toBe("tok");
  });

  it("too long: refused, echo back on", async () => {
    const { s, modes } = tty();
    const p = readTokenLine(s, () => {}, opts);
    await new Promise((r) => setTimeout(r, 40));
    s.write("x".repeat(TOKEN_LINE_MAX + 1));
    await expect(p).rejects.toThrow(/longer than/);
    expect(modes).toEqual([true, false]);
  });

  it("late: refused, echo back on", async () => {
    const { s, modes } = tty();
    const p = readTokenLine(s, () => {}, { ...opts, timeoutMs: 60 });
    await expect(p).rejects.toThrow(/no token within/);
    expect(modes).toEqual([true, false]);
  });

  it("an empty line, a space or a control byte: refused", async () => {
    for (const line of ["\n", "a\u0003b\n", "a b\n"]) {
      const { s } = tty();
      const p = readTokenLine(s, () => {}, opts);
      await new Promise((r) => setTimeout(r, 40));
      s.write(line);
      await expect(p).rejects.toThrow(/not a token/);
    }
  });

  it("not a terminal, or a nonce that isn't Den's shape: refused before any marker", async () => {
    const said: string[] = [];
    await expect(readTokenLine(new PassThrough(), (t) => said.push(t), opts)).rejects.toThrow(
      /not a terminal/,
    );
    await expect(
      readTokenLine(tty().s, (t) => said.push(t), { ...opts, nonce: "short" }),
    ).rejects.toThrow(/nonce/);
    expect(said).toEqual([]);
  });
});

describe("issue 988: Den's host waits for its marker", () => {
  it("strips the marker from the output and says ready once", () => {
    const w = watchReady(N);
    expect(w.feed("hello")).toEqual({ show: "hello", state: "waiting" });
    expect(w.feed(`a${readyMarker(N)}b`)).toEqual({ show: "ab", state: "ready" });
    expect(w.feed("later")).toEqual({ show: "later", state: "ready" });
  });

  it("a marker split across two chunks is still found, and never shown", () => {
    const w = watchReady(N);
    const m = readyMarker(N);
    const a = w.feed(`x${m.slice(0, 10)}`);
    const b = w.feed(`${m.slice(10)}y`);
    expect(a.show + b.show).toBe("xy");
    expect(b.state).toBe("ready");
  });

  it("a marker with another nonce, or a second marker: refused, no token written", () => {
    const w = watchReady(N);
    expect(w.feed(readyMarker("f".repeat(32))).state).toBe("refused");
    const w2 = watchReady(N);
    w2.feed(readyMarker(N));
    expect(w2.feed(readyMarker(N)).state).toBe("refused");
  });

  it("nonces are fresh and hex", () => {
    const a = newLaunchNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newLaunchNonce()).not.toBe(a);
  });
});
