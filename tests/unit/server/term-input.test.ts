/**
 * The Agents tab's terminal input and links (AG-4b), term-input.js:
 *
 *   - which URLs open (http and https only; javascript:, data:, file: and
 *     the rest never);
 *   - the modifier that opens a link: ⌘ on a Mac, Ctrl elsewhere;
 *   - the path matcher: `src/foo.ts:42`, `./a/b.js:3:7`, absolute paths;
 *     not URLs, not bare words;
 *   - the editor's URL for a path and line (vscode, cursor, zed; none:
 *     no URL, the path is copied);
 *   - Shift+Enter (no other modifier) is the soft newline; ⌃⇧1/2/3 are the
 *     layouts, by the key's code (Shift+1 is "!" on a US keyboard).
 */
import { describe, expect, it } from "@jest/globals";
import {
  editorUrl,
  findPaths,
  isWebUrl,
  layoutKeyIndex,
  linkModifier,
  softNewlineKey,
} from "../../../src/ui/server/public/term-input.js";

const key = (over: Partial<KeyboardEvent>) =>
  ({
    type: "keydown",
    key: "",
    code: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...over,
  }) as KeyboardEvent;

describe("which links open", () => {
  it("http and https only", () => {
    for (const u of [
      "https://example.test/a?b=c#d",
      "http://localhost:4000/x",
      "HTTPS://EXAMPLE.TEST",
    ])
      expect([u, isWebUrl(u)]).toEqual([u, true]);
    for (const u of [
      "javascript:alert(1)",
      " javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "vscode://file/etc/passwd",
      "mailto:a@example.test",
      "//example.test",
      "https:",
      "",
      "not a url",
    ])
      expect([u, isWebUrl(u)]).toEqual([u, false]);
  });

  it("the modifier: ⌘ on a Mac, Ctrl elsewhere; never Shift or Alt alone", () => {
    expect(
      linkModifier({ metaKey: true, ctrlKey: false } as MouseEvent, true),
    ).toBe(true);
    expect(
      linkModifier({ metaKey: false, ctrlKey: true } as MouseEvent, true),
    ).toBe(false);
    expect(
      linkModifier({ metaKey: false, ctrlKey: true } as MouseEvent, false),
    ).toBe(true);
    expect(
      linkModifier({ metaKey: true, ctrlKey: false } as MouseEvent, false),
    ).toBe(false);
    expect(linkModifier({} as MouseEvent, true)).toBe(false);
    expect(linkModifier(undefined, true)).toBe(false);
  });
});

describe("the path matcher", () => {
  const paths = (line: string) =>
    findPaths(line).map((m) => [m.text, m.path, m.line ?? null, m.col ?? null]);

  it("finds relative and absolute paths, with a line and column", () => {
    expect(paths("Edited src/foo.ts:42 and ./a/b.js:3:7.")).toEqual([
      ["src/foo.ts:42", "src/foo.ts", 42, null],
      ["./a/b.js:3:7", "./a/b.js", 3, 7],
    ]);
    expect(paths("see /work/north/README.md, then ../up/x.py")).toEqual([
      ["/work/north/README.md", "/work/north/README.md", null, null],
      ["../up/x.py", "../up/x.py", null, null],
    ]);
    expect(paths("(src/a.ts) 'src/b.ts' \"src/c.ts\"")).toEqual([
      ["src/a.ts", "src/a.ts", null, null],
      ["src/b.ts", "src/b.ts", null, null],
      ["src/c.ts", "src/c.ts", null, null],
    ]);
    // A file name with a line, no directory.
    expect(paths("foo.ts:12 failed")).toEqual([
      ["foo.ts:12", "foo.ts", 12, null],
    ]);
  });

  it("each match's columns are where it is in the line", () => {
    const line = "x src/foo.ts:42 y";
    const [m] = findPaths(line);
    expect(line.slice(m.start, m.end)).toBe("src/foo.ts:42");
  });

  it("never a URL, a bare word, a version or a fraction", () => {
    for (const line of [
      "https://example.test/src/foo.ts",
      "open http://localhost:3000/a/b now",
      "and/or",
      "v1.2.3",
      "3/4 done",
      "foo.ts",
      "a // comment",
      "",
    ])
      expect([line, paths(line)]).toEqual([line, []]);
  });
});

describe("the editor's URL", () => {
  it("vscode, cursor and zed by URL scheme, with the line; none has none", () => {
    expect(editorUrl("vscode", "/w/n/src/x.ts", 10)).toBe(
      "vscode://file/w/n/src/x.ts:10",
    );
    expect(editorUrl("cursor", "/w/n/src/x.ts", 10, 4)).toBe(
      "cursor://file/w/n/src/x.ts:10:4",
    );
    expect(editorUrl("zed", "/w/n/src/x.ts", 10)).toBe(
      "zed://file/w/n/src/x.ts:10",
    );
    expect(editorUrl("vscode", "/w/n/a b#c.ts")).toBe(
      "vscode://file/w/n/a%20b%23c.ts",
    );
    expect(editorUrl("none", "/w/n/src/x.ts", 10)).toBeNull();
    expect(editorUrl("emacs", "/w/n/src/x.ts", 10)).toBeNull();
    expect(editorUrl("vscode", "relative/x.ts", 10)).toBeNull();
  });
});

describe("the keys", () => {
  it("Shift+Enter alone is the soft newline", () => {
    expect(softNewlineKey(key({ key: "Enter", shiftKey: true }))).toBe(true);
    expect(softNewlineKey(key({ key: "Enter" }))).toBe(false);
    for (const m of ["ctrlKey", "altKey", "metaKey"] as const)
      expect(
        softNewlineKey(key({ key: "Enter", shiftKey: true, [m]: true })),
      ).toBe(false);
    expect(
      softNewlineKey(key({ type: "keyup", key: "Enter", shiftKey: true })),
    ).toBe(false);
    expect(
      softNewlineKey(key({ key: "Enter", shiftKey: true, isComposing: true })),
    ).toBe(false);
  });

  it("⌃⇧1/2/3 are the layouts, by code; ⌘1-3 and Ctrl+1-3 are the browser's", () => {
    expect(
      layoutKeyIndex(
        key({ code: "Digit1", key: "!", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(0);
    expect(
      layoutKeyIndex(
        key({ code: "Digit3", key: "#", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(2);
    expect(
      layoutKeyIndex(key({ code: "Digit4", ctrlKey: true, shiftKey: true })),
    ).toBe(-1);
    expect(
      layoutKeyIndex(key({ code: "Digit1", key: "1", metaKey: true })),
    ).toBe(-1);
    expect(
      layoutKeyIndex(key({ code: "Digit1", key: "1", ctrlKey: true })),
    ).toBe(-1);
    expect(
      layoutKeyIndex(
        key({ code: "Digit1", ctrlKey: true, shiftKey: true, metaKey: true }),
      ),
    ).toBe(-1);
    expect(
      layoutKeyIndex(
        key({ code: "Digit1", ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(-1);
  });
});
