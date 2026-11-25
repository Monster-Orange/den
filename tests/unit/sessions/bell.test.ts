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

describe("BellScanner: OSC 7501 status (issue 771)", () => {
  const ST = `${ESC}\\`;
  it.each(["idle", "working", "done", "blocked", "error"])(
    "state=%s, ST-terminated, is read (and isn't a bell)",
    (state) => {
      const s = new BellScanner();
      expect(feed(s, `a${ESC}]7501;state=${state}${ST}b`)).toEqual([false]);
      expect(s.takeStatus()).toEqual({ state });
      expect(s.takeStatus()).toBeNull();
    },
  );

  it("the BEL-terminated form reads the same, with its id; the BEL isn't a bell", () => {
    const s = new BellScanner();
    expect(feed(s, `${ESC}]7501;state=blocked;id=job-1${BEL}`)).toEqual([
      false,
    ]);
    expect(s.takeStatus()).toEqual({ state: "blocked", id: "job-1" });
  });

  it("split across chunks: read once", () => {
    const s = new BellScanner();
    feed(s, `x${ESC}]75`, `01;state=wor`);
    expect(s.takeStatus()).toBeNull();
    feed(s, `king${ESC}`, `\\y`);
    expect(s.takeStatus()).toEqual({ state: "working" });
    feed(s, "more output");
    expect(s.takeStatus()).toBeNull();
  });

  it("the last of several in one chunk wins", () => {
    const s = new BellScanner();
    feed(s, `${ESC}]7501;state=working${ST}${ESC}]7501;state=done${BEL}`);
    expect(s.takeStatus()).toEqual({ state: "done" });
  });

  it("an unknown state or a malformed sequence is ignored and keeps the last one", () => {
    const s = new BellScanner();
    feed(s, `${ESC}]7501;state=working${ST}`);
    for (const bad of [
      `${ESC}]7501;state=sleeping${ST}`,
      `${ESC}]7501;state=${ST}`,
      `${ESC}]7501;${ST}`,
      `${ESC}]7501${BEL}`,
      `${ESC}]7501;id=x${BEL}`,
      `${ESC}]75010;state=idle${BEL}`,
      `${ESC}]7501;State=idle${BEL}`,
      `${ESC}]7501;state=idle;state=done${BEL}`,
      `${ESC}]7501;state=idle;id=${"x".repeat(200)}${BEL}`,
      `${ESC}]7501;state=idle;id=a b${BEL}`,
      `${ESC}]7501;state=idle${ESC}[0m`,
    ])
      expect(() => feed(s, bad)).not.toThrow();
    expect(s.takeStatus()).toEqual({ state: "working" });
  });

  it("other keys are skipped; bells around it still ring", () => {
    const s = new BellScanner();
    expect(
      feed(s, `${BEL}${ESC}]7501;v=1;state=idle;x=y${ST}${ESC}]9;hi${BEL}`),
    ).toEqual([true]);
    expect(s.takeStatus()).toEqual({ state: "idle" });
  });
});
