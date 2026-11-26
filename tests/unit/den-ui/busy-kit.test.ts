/**
 * den-ui UK-2: the kit's working pop-up, the checks that need no browser.
 *
 *   - src/busy.js names no product: no "den" identifier, word or global
 *     apart from its custom element's tag (<den-busy>). A product plugs
 *     itself in through configureBusy and registerActions.
 *   - The shared words have the same keys and the same {placeholders} in
 *     en, es and ja.
 *   - The timings are the Settled ones.
 *
 * The browser half (opens, holds, Try again, Check again, held, reconnect)
 * is busy-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

/** Each product name left once the element's tag is taken out. */
export function productNames(src: string): string[] {
  // The element's tag, and the kit's one button's class (issue 673).
  const rest = src.replace(/den-busy|den-btn/g, "");
  return [...rest.matchAll(/\b[dD]en(?:[A-Z_$][\w$]*)?\b/g)].map((m) => m[0]);
}

type Words = Record<string, Record<string, string>>;
const loadWords = (): Words =>
  new Function(
    read("busy-words.js").replace(/export\s+const\s+BUSY_WORDS\s*=/, "return"),
  )() as Words;

const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("UK-2 kit: busy.js names no product", () => {
  it("finds a product name when one is there (the check can fail)", () => {
    expect(productNames("const t = window.denShell.t;")).toEqual(["denShell"]);
    expect(productNames("// ask Den")).toEqual(["Den"]);
    expect(productNames('h["X-Den-Request-Id"]')).toEqual(["Den"]);
    expect(productNames('createElement("den-busy"); hidden; padEnd')).toEqual(
      [],
    );
  });

  it("busy.js and busy-words.js have none apart from the tag", () => {
    expect(productNames(read("busy.js"))).toEqual([]);
    expect(productNames(read("busy-words.js"))).toEqual([]);
  });
});

describe("UK-2 kit: the shared words", () => {
  const w = loadWords();
  it("en, es and ja have the same keys", () => {
    const en = Object.keys(w.en!).sort();
    expect(Object.keys(w).sort()).toEqual(["en", "es", "ja"]);
    expect(Object.keys(w.es!).sort()).toEqual(en);
    expect(Object.keys(w.ja!).sort()).toEqual(en);
  });
  it("each word has the same {placeholders} in every language", () => {
    for (const k of Object.keys(w.en!))
      for (const l of ["es", "ja"])
        expect([l, k, holes(w[l]![k]!)]).toEqual([l, k, holes(w.en![k]!)]);
  });
  it("busy.js asks only for words the kit has", () => {
    const asked = new Set(
      [...read("busy.js").matchAll(/\bword\("(\w+)"/g)].map((m) => m[1]),
    );
    const btns = [...read("busy.js").matchAll(/\bbtn\("(\w+)"/g)].map(
      (m) => m[1],
    );
    for (const b of btns) asked.add(b);
    const missing = [...asked].filter((k) => !(k! in w.en!));
    expect(missing).toEqual([]);
  });
});

describe("UK-2 kit: the Settled timings", () => {
  const src = read("busy.js");
  const val = (n: string) =>
    Number(
      new RegExp(`export const ${n} = ([\\d_]+);`)
        .exec(src)?.[1]
        ?.replace(/_/g, ""),
    );
  it("opens at 300 ms, shows at least 600 ms, still at 10 s, no answer at 60 s, closes a success at 1.2 s", () => {
    expect(val("OPEN_MS")).toBe(300);
    expect(val("MIN_MS")).toBe(600);
    expect(val("STILL_MS")).toBe(10000);
    expect(val("NO_ANSWER_MS")).toBe(60000);
    expect(val("SUCCESS_CLOSE_MS")).toBe(1200);
  });
  it("reconnect asks every 1 s backing off to 3 s, each given up after 3 s", () => {
    expect(val("POLL_MS")).toBe(1000);
    expect(val("POLL_MAX_MS")).toBe(3000);
    expect(val("ASK_MS")).toBe(3000);
  });
});
