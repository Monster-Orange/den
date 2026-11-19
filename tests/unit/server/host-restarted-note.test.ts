/**
 * Issue 563: the bell line after the terminal host restarts reads as a
 * sentence in every case (no "(0): -"), in en, es and ja, and never uses
 * the word "Open" (issue 93: no row says Open).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { noteHostRestarted } from "../../../src/ui/server/agent-routes.js";

const PUB = path.resolve(__dirname, "../../../src/ui/server/public");

function note(resumed: string[], terminals: number) {
  const added: { text: string; msg: { key: string; vars: Record<string, unknown> } }[] = [];
  noteHostRestarted(
    { add: (n: never) => void added.push(n) } as never,
    "Den",
    resumed,
    terminals,
  );
  return added[0];
}

function catalog(file: string, key: string): string | null {
  const src = fs.readFileSync(path.join(PUB, file), "utf-8");
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*\\n?\\s*"([^"]*)"`).exec(src);
  return m ? m[1] : null;
}

const CASES: [string[], number][] = [
  [["a", "b"], 2],
  [["a"], 0],
  [[], 3],
  [[], 0],
];

describe("the bell line after the terminal host restarts", () => {
  it.each(CASES)("resumed %j, %i terminals: a sentence, no (0) or -, no Open", (resumed, t) => {
    const n = note(resumed, t);
    expect(n.text).not.toMatch(/\(0\)|: -|\bOpen\b/);
    for (const file of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const words = catalog(file, n.msg.key);
      expect([file, n.msg.key, words === null]).toEqual([file, n.msg.key, false]);
      const filled = words!.replace(/\{(\w+)\}/g, (_, k) => String(n.msg.vars[k]));
      expect(filled).not.toMatch(/\(0\)|: -\.|\bOpen\b|\bAbrir\b|開く/);
    }
  });
});
