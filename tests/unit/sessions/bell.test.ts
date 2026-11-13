/**
 * NT-1 (3): the terminal's own "look at me" signals in a session's output:
 * a bare BEL, OSC 9 (a desktop notification; not OSC 9;4, which is a
 * progress bar) and OSC 777;notify. A BEL that ends an OSC (a title, a
 * link) is not one. Split across chunks, it still counts once.
 */
import { BellScanner } from "../../../src/shared/sessions/bell";

const ESC = "\u001b";
const BEL = "\u0007";
const feed = (s: BellScanner, ...parts: string[]) =>
  parts.map((p) => s.feed(Buffer.from(p, "utf8")));

describe("BellScanner", () => {
  it("plain output: nothing", () => {
    expect(
      feed(new BellScanner(), "hello\r\n", `${ESC}[1;32mok${ESC}[0m`),
    ).toEqual([false, false]);
  });

  it("a bare BEL rings", () => {
    expect(feed(new BellScanner(), `done${BEL}`)).toEqual([true]);
  });

  it("a BEL ending an OSC title or link doesn't", () => {
    const s = new BellScanner();
    expect(
      feed(
        s,
        `${ESC}]0;my title${BEL}`,
        `${ESC}]8;;https://example.test${BEL}link${ESC}]8;;${BEL}`,
      ),
    ).toEqual([false, false]);
  });

  it("OSC 9 and OSC 777;notify ring, with BEL or ST; OSC 9;4 progress doesn't", () => {
    const s = new BellScanner();
    expect(
      feed(
        s,
        `${ESC}]9;Needs input${BEL}`,
        `${ESC}]777;notify;Agent;Waiting${ESC}\\`,
        `${ESC}]9;4;1;50${BEL}`,
      ),
    ).toEqual([true, true, false]);
  });

  it("split across chunks: the OSC's end in the next one still isn't a bell", () => {
    const s = new BellScanner();
    expect(feed(s, `${ESC}]0;ti`, `tle${BEL}more`)).toEqual([false, false]);
    expect(feed(s, `${ESC}`, `]9;hi`, BEL)).toEqual([false, false, true]);
  });

  it("an OSC that never ends is dropped after 512 bytes; a later BEL rings", () => {
    const s = new BellScanner();
    expect(feed(s, `${ESC}]0;${"x".repeat(600)}`, `${BEL}`)).toEqual([
      false,
      true,
    ]);
  });
});
